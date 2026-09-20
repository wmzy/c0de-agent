// URL 内置解析器（file://, skill://）测试。
// registry 框架（createURLRegistry/resolveURL 分发）见 ../resolver.test.ts。
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { URLResolveContext } from '../../shared/types/tool.js'
import { resolveURL } from '../resolver.js'
import { createDefaultURLRegistry, createFileResolver, createSkillResolver } from './resolvers.js'

function ctxAt(cwd: string): URLResolveContext {
  return { cwd, session: { id: 's1', cwd } }
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), `c0de-resolver-${Date.now()}-`))
}

describe('file resolver', () => {
  it('reads a file by relative file:// URL', async () => {
    const cwd = await tmp()
    await writeFile(join(cwd, 'main.ts'), 'export const x = 1')
    const reg = createDefaultURLRegistry()
    const res = await resolveURL(reg, 'file://main.ts', ctxAt(cwd))
    expect(res._tag).toBe('ok')
    if (res._tag === 'ok') expect(res.content).toBe('export const x = 1')
  })

  // file:// 曾完全绕过 cwd 沙箱：resolvePath 放行任意绝对路径与 ../，
  // read 工具 permission=auto 下模型可无确认读取工作目录外文件（如 ~/.ssh）。
  // 现与 read/grep/glob/bash 同口径：解析结果必须落在 cwd 内。
  it('reads a file by absolute file:// URL when the path is inside cwd', async () => {
    const cwd = await tmp()
    const abs = join(cwd, 'sub', 'a.txt')
    await mkdir(join(cwd, 'sub'))
    await writeFile(abs, 'hello')
    const reg = createDefaultURLRegistry()
    const res = await resolveURL(reg, `file://${abs}`, ctxAt(cwd))
    expect(res._tag).toBe('ok')
    if (res._tag === 'ok') expect(res.content).toBe('hello')
  })

  it('rejects absolute file:// paths outside the working directory', async () => {
    const cwd = await tmp()
    const outside = await tmp()
    await writeFile(join(outside, 'secret.txt'), 's3cret')
    const reg = createDefaultURLRegistry()
    const res = await resolveURL(reg, `file://${join(outside, 'secret.txt')}`, ctxAt(cwd))
    expect(res._tag).toBe('error')
  })

  it('rejects ../ traversal outside the working directory', async () => {
    const parent = await tmp()
    const cwd = join(parent, 'work')
    await mkdir(cwd, { recursive: true })
    await writeFile(join(parent, 'secret.txt'), 's3cret')
    const reg = createDefaultURLRegistry()
    const res = await resolveURL(reg, 'file://../secret.txt', ctxAt(cwd))
    expect(res._tag).toBe('error')
  })

  it('returns error when the file does not exist', async () => {
    const cwd = await tmp()
    const reg = createDefaultURLRegistry()
    const res = await resolveURL(reg, 'file://missing.ts', ctxAt(cwd))
    expect(res._tag).toBe('error')
  })
})

describe('skill resolver', () => {
  it('reads a project skill from .c0de/skills/<name>.md', async () => {
    const cwd = await tmp()
    await mkdir(join(cwd, '.c0de', 'skills'), { recursive: true })
    await writeFile(join(cwd, '.c0de', 'skills', 'brainstorming.md'), '# Skill\nstep 1')
    const reg = createDefaultURLRegistry()
    const res = await resolveURL(reg, 'skill://brainstorming', ctxAt(cwd))
    expect(res._tag).toBe('ok')
    if (res._tag === 'ok') expect(res.content).toContain('step 1')
  })

  it('reads a project skill from .c0de/skills/<name>/SKILL.md', async () => {
    const cwd = await tmp()
    await mkdir(join(cwd, '.c0de', 'skills', 'tdd'), { recursive: true })
    await writeFile(join(cwd, '.c0de', 'skills', 'tdd', 'SKILL.md'), '# TDD')
    const reg = createDefaultURLRegistry()
    const res = await resolveURL(reg, 'skill://tdd', ctxAt(cwd))
    expect(res._tag).toBe('ok')
    if (res._tag === 'ok') expect(res.content).toContain('TDD')
  })

  it('falls back to the global ~/.c0de/skills/<name>.md', async () => {
    const cwd = await tmp()
    const home = await tmp()
    await mkdir(join(home, '.c0de', 'skills'), { recursive: true })
    await writeFile(join(home, '.c0de', 'skills', 'global.md'), '# Global skill')
    const reg = createURLRegistryWithSkill({ homeDir: home })
    const res = await resolveURL(reg, 'skill://global', ctxAt(cwd))
    expect(res._tag).toBe('ok')
    if (res._tag === 'ok') expect(res.content).toContain('Global skill')
  })

  it('returns error when the skill is nowhere to be found', async () => {
    const cwd = await tmp()
    const home = await tmp()
    const reg = createURLRegistryWithSkill({ homeDir: home })
    const res = await resolveURL(reg, 'skill://nonexistent', ctxAt(cwd))
    expect(res._tag).toBe('error')
  })

  it('project skill takes precedence over global skill', async () => {
    const cwd = await tmp()
    const home = await tmp()
    await mkdir(join(cwd, '.c0de', 'skills'), { recursive: true })
    await mkdir(join(home, '.c0de', 'skills'), { recursive: true })
    await writeFile(join(cwd, '.c0de', 'skills', 'dup.md'), 'PROJECT')
    await writeFile(join(home, '.c0de', 'skills', 'dup.md'), 'GLOBAL')
    const reg = createURLRegistryWithSkill({ homeDir: home })
    const res = await resolveURL(reg, 'skill://dup', ctxAt(cwd))
    expect(res._tag).toBe('ok')
    if (res._tag === 'ok') expect(res.content).toBe('PROJECT')
  })

  // 回归：name 未校验为单路径段——'../config' 可读出 .c0de/config.md，
  // 绝对路径（resolvePath 遇到绝对段会重置前缀）可读出磁盘任意 .md 文件。
  it('rejects ../ traversal in skill names', async () => {
    const cwd = await tmp()
    await mkdir(join(cwd, '.c0de'), { recursive: true })
    await writeFile(join(cwd, '.c0de', 'config.md'), 'cfg')
    const reg = createDefaultURLRegistry()
    const res = await resolveURL(reg, 'skill://../config', ctxAt(cwd))
    expect(res._tag).toBe('error')
  })

  it('rejects absolute paths in skill names', async () => {
    const cwd = await tmp()
    const elsewhere = await tmp()
    await writeFile(join(elsewhere, 'loot.md'), 'loot')
    const reg = createDefaultURLRegistry()
    // 去掉 .md 后缀：旧实现 resolvePath 遇绝对段重置前缀，读到 elsewhere/loot.md
    const res = await resolveURL(reg, `skill://${join(elsewhere, 'loot')}`, ctxAt(cwd))
    expect(res._tag).toBe('error')
  })

  it('rejects dot segments in skill names', async () => {
    const cwd = await tmp()
    const reg = createDefaultURLRegistry()
    expect((await resolveURL(reg, 'skill://..', ctxAt(cwd)))._tag).toBe('error')
    expect((await resolveURL(reg, 'skill://.', ctxAt(cwd)))._tag).toBe('error')
  })
})

describe('createDefaultURLRegistry', () => {
  it('registers both file and skill schemes', async () => {
    const reg = createDefaultURLRegistry()
    expect(reg.resolvers.has('file')).toBe(true)
    expect(reg.resolvers.has('skill')).toBe(true)
  })

  it('exposes the individual resolvers via factories', () => {
    expect(createFileResolver().scheme).toBe('file')
    expect(createSkillResolver().scheme).toBe('skill')
  })
})

function createURLRegistryWithSkill(opts: { homeDir: string }) {
  const reg = createDefaultURLRegistry({ homeDir: opts.homeDir })
  return reg
}
