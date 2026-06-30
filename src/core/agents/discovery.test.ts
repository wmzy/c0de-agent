import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadAgentFile, loadAgents } from './discovery.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c0de-agent-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('loadAgentFile', () => {
  it('解析 frontmatter + 正文为 AgentDefinition', async () => {
    const file = join(tmpDir, 'researcher.md')
    await writeFile(
      file,
      [
        '---',
        'name: researcher',
        'description: 只读调研',
        'tools: [grep, glob, read]',
        'model: deepseek/deepseek-v4',
        'isolated: false',
        'maxRecursion: 0',
        '---',
        'You are a read-only scout.',
        '',
      ].join('\n'),
    )
    const def = await loadAgentFile(file, 'project')
    expect(def).not.toBeNull()
    expect(def?.name).toBe('researcher')
    expect(def?.description).toBe('只读调研')
    expect(def?.tools).toEqual(['grep', 'glob', 'read'])
    expect(def?.model).toBe('deepseek/deepseek-v4')
    expect(def?.isolated).toBe(false)
    expect(def?.maxRecursion).toBe(0)
    expect(def?.systemPrompt).toContain('read-only scout')
    expect(def?.source).toBe('project')
    expect(def?.filePath).toBe(file)
  })

  it('name 缺省时取文件名（去扩展名）', async () => {
    const file = join(tmpDir, 'coder.md')
    await writeFile(file, '---\ndescription: coder\n---\nYou are a coder.')
    const def = await loadAgentFile(file, 'user')
    expect(def?.name).toBe('coder')
  })

  it('mode 默认 subagent', async () => {
    const file = join(tmpDir, 'x.md')
    await writeFile(file, '---\ndescription: x\n---\nprompt')
    const def = await loadAgentFile(file, 'user')
    expect(def?.mode).toBe('subagent')
  })

  it('frontmatter 显式设置 mode', async () => {
    const file = join(tmpDir, 'main.md')
    await writeFile(file, '---\nname: main\nmode: primary\n---\nprompt')
    const def = await loadAgentFile(file, 'user')
    expect(def?.mode).toBe('primary')
  })

  it('无 frontmatter 的文件返回 null', async () => {
    const file = join(tmpDir, 'bad.md')
    await writeFile(file, 'just some text without frontmatter')
    const def = await loadAgentFile(file, 'user')
    expect(def).toBeNull()
  })
})

describe('loadAgents', () => {
  it('加载项目 agents 目录下所有 .md', async () => {
    const agentsDir = join(tmpDir, '.c0de', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, 'a.md'),
      '---\nname: a\ndescription: agent a\n---\nprompt a',
    )
    await writeFile(
      join(agentsDir, 'b.md'),
      '---\nname: b\ndescription: agent b\n---\nprompt b',
    )
    const defs = await loadAgents(tmpDir)
    expect(defs.map((d) => d.name).sort()).toEqual(['a', 'b'])
  })

  it('目录不存在时返回空数组', async () => {
    const defs = await loadAgents(tmpDir)
    expect(defs).toEqual([])
  })

  it('跳过无 frontmatter 的文件', async () => {
    const agentsDir = join(tmpDir, '.c0de', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'good.md'), '---\nname: good\n---\nprompt')
    await writeFile(join(agentsDir, 'bad.md'), 'no frontmatter here')
    const defs = await loadAgents(tmpDir)
    expect(defs.map((d) => d.name)).toEqual(['good'])
  })
})
