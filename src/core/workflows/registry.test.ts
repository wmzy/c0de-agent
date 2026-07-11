import { describe, expect, it } from 'vitest'
import type { WorkflowEntry } from './types.js'
import { createWorkflowRegistry } from './registry.js'

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
})