import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAndPopulateRegistry, createWorkflowRegistry, reloadRegistry } from './registry.js'
import type { WorkflowEntry } from './types.js'

function makeEntry(name: string, source: WorkflowEntry['source'] = 'builtin'): WorkflowEntry {
  return {
    meta: { name, description: `${name} workflow` },
    source,
    execute: async () => ({ output: `${name} ran` }),
  }
}

describe('WorkflowRegistry', () => {
  it('registers and retrieves by name', () => {
    const reg = createWorkflowRegistry()
    reg.register(makeEntry('security-audit'))
    expect(reg.has('security-audit')).toBe(true)
    expect(reg.get('security-audit')?.meta.name).toBe('security-audit')
  })

  it('returns undefined for unknown name', () => {
    const reg = createWorkflowRegistry()
    expect(reg.get('nonexistent')).toBeUndefined()
    expect(reg.has('nonexistent')).toBe(false)
  })

  it('later registration overwrites earlier same-name entry', () => {
    const reg = createWorkflowRegistry()
    reg.register(makeEntry('audit', 'builtin'))
    reg.register(makeEntry('audit', 'project'))
    const entry = reg.get('audit')
    expect(entry?.source).toBe('project')
  })

  it('lists all registered entries', () => {
    const reg = createWorkflowRegistry()
    reg.register(makeEntry('a'))
    reg.register(makeEntry('b'))
    reg.register(makeEntry('c'))
    expect(reg.list().length).toBe(3)
    expect(reg.list().map((e) => e.meta.name)).toContain('a')
    expect(reg.list().map((e) => e.meta.name)).toContain('c')
  })

  it('deletes entry and returns true', () => {
    const reg = createWorkflowRegistry()
    reg.register(makeEntry('temp'))
    expect(reg.delete('temp')).toBe(true)
    expect(reg.has('temp')).toBe(false)
  })

  it('returns false when deleting nonexistent entry', () => {
    const reg = createWorkflowRegistry()
    expect(reg.delete('ghost')).toBe(false)
  })

  it('clear empties the registry', () => {
    const reg = createWorkflowRegistry()
    reg.register(makeEntry('a'))
    reg.register(makeEntry('b'))
    expect(reg.list().length).toBe(2)
    reg.clear()
    expect(reg.list().length).toBe(0)
    expect(reg.has('a')).toBe(false)
  })
})

describe('reloadRegistry', () => {
  const originalHome = process.env.HOME
  let homeDir: string
  let projectDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'wf-reload-home-'))
    projectDir = await mkdtemp(join(tmpdir(), 'wf-reload-proj-'))
    process.env.HOME = homeDir
  })

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await rm(homeDir, { recursive: true, force: true })
    await rm(projectDir, { recursive: true, force: true })
  })

  const WF_SOURCE = `
export const meta = { name: 'reload-test', description: 'reload test wf' }
export default async function workflow(ctx) {
  return { output: 'done' }
}
`

  it('repopulates registry from disk (project-level workflow discovered)', async () => {
    // 初始注册表：只有内置
    const registry = await createAndPopulateRegistry(projectDir)
    expect(registry.has('security-audit')).toBe(true)
    expect(registry.has('reload-test')).toBe(false)

    // 写入自定义工作流到项目目录
    await mkdir(join(projectDir, '.c0de/workflows'), { recursive: true })
    await writeFile(join(projectDir, '.c0de/workflows', 'reload-test.js'), WF_SOURCE, 'utf-8')

    // 热重载
    await reloadRegistry(registry, projectDir)

    // 内置仍在，自定义工作流被发现
    expect(registry.has('security-audit')).toBe(true)
    expect(registry.has('reload-test')).toBe(true)
  })

  it('preserves same registry reference after reload', async () => {
    const registry = await createAndPopulateRegistry(projectDir)
    const refBefore = registry
    await reloadRegistry(registry, projectDir)
    expect(refBefore).toBe(registry)
  })
})
