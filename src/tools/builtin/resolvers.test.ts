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

  it('reads a file by absolute file:// URL', async () => {
    const cwd = await tmp()
    const abs = join(cwd, 'sub', 'a.txt')
    await mkdir(join(cwd, 'sub'))
    await writeFile(abs, 'hello')
    const reg = createDefaultURLRegistry()
    const res = await resolveURL(reg, `file://${abs}`, ctxAt('/other'))
    expect(res._tag).toBe('ok')
    if (res._tag === 'ok') expect(res.content).toBe('hello')
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
