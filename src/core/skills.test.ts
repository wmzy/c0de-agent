import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverSkills } from './skills.js'

function writeSkill(base: string, dirName: string, md: string): string {
  const dir = join(base, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), md)
  return dir
}

const prevConfigDir = process.env.C0DE_CONFIG_DIR
const cleanups: string[] = []

/** 每个用例独立的 tmp cwd/global 目录——discoverSkills 按 cwd 缓存（进程级），
 *  用例共享 cwd 会让后写的前置技能污染后一用例的期望。 */
function makeTmp(prefix: string): string {
  const p = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(p)
  return p
}

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.C0DE_CONFIG_DIR
  else process.env.C0DE_CONFIG_DIR = prevConfigDir
  for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true })
})

describe('discoverSkills', () => {
  it('returns [] when no skill dirs exist', () => {
    const cwd = makeTmp('skills-cwd-')
    const globalDir = makeTmp('skills-global-')
    process.env.C0DE_CONFIG_DIR = globalDir
    expect(discoverSkills(join(cwd, 'none')).length).toBe(0)
  })

  it('discovers project and global skills, preferring frontmatter name', () => {
    const cwd = makeTmp('skills-cwd-')
    const globalDir = makeTmp('skills-global-')
    process.env.C0DE_CONFIG_DIR = globalDir
    const projSkills = join(cwd, '.c0de', 'skills')
    writeSkill(projSkills, 'alpha', '---\nname: my-alpha\ndescription: test\n---\n# Alpha')
    writeSkill(projSkills, 'no-frontmatter', '# plain markdown')
    // 全局技能位于 <config>/skills/<name>/SKILL.md（C0DE_CONFIG_DIR 重定向的全局目录）
    writeSkill(join(globalDir, 'skills'), 'beta', '---\nname: my-beta\n---\n# Beta')
    // 无 SKILL.md 的目录不是技能
    mkdirSync(join(projSkills, 'empty-dir'), { recursive: true })
    // 非目录文件不是技能
    writeFileSync(join(projSkills, 'stray.md'), 'x')

    const names = discoverSkills(cwd)
    // 项目级在前、全局级在后（各组内按名排序）
    expect(names).toEqual(['my-alpha', 'no-frontmatter', 'my-beta'])
  })

  it('caches per cwd within the process lifetime', () => {
    const cwd = makeTmp('skills-cwd-')
    const globalDir = makeTmp('skills-global-')
    process.env.C0DE_CONFIG_DIR = globalDir
    const projSkills = join(cwd, '.c0de', 'skills')
    writeSkill(projSkills, 'first', '---\nname: first\n---\n# 1')
    expect(discoverSkills(cwd)).toEqual(['first'])
    // 新增技能在缓存生效后不可见（技能是 system prompt 材料，运行中热加载无意义）
    writeSkill(projSkills, 'second', '---\nname: second\n---\n# 2')
    expect(discoverSkills(cwd)).toEqual(['first'])
    expect(existsSync(join(projSkills, 'second'))).toBe(true)
  })
})
