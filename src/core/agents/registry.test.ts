import { describe, expect, it } from 'vitest'
import { createAgentRegistry } from './registry.js'
import type { AgentDefinition } from './types.js'

const def = (name: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name,
  description: `${name} agent`,
  systemPrompt: `You are ${name}.`,
  mode: 'subagent',
  source: 'builtin',
  ...overrides,
})

describe('AgentRegistry', () => {
  it('registers and retrieves a definition by name', () => {
    const reg = createAgentRegistry()
    reg.register(def('researcher'))
    expect(reg.get('researcher')?.name).toBe('researcher')
  })

  it('has() reports presence', () => {
    const reg = createAgentRegistry()
    reg.register(def('coder'))
    expect(reg.has('coder')).toBe(true)
    expect(reg.has('missing')).toBe(false)
  })

  it('list() returns all definitions by default', () => {
    const reg = createAgentRegistry()
    reg.register(def('coder'))
    reg.register(def('researcher'))
    expect(
      reg
        .list()
        .map((d) => d.name)
        .sort(),
    ).toEqual(['coder', 'researcher'])
  })

  it('list(mode) filters by mode', () => {
    const reg = createAgentRegistry()
    reg.register(def('coder', { mode: 'subagent' }))
    reg.register(def('main', { mode: 'primary' }))
    reg.register(def('general', { mode: 'all' }))
    expect(
      reg
        .list('subagent')
        .map((d) => d.name)
        .sort(),
    ).toEqual(['coder', 'general'])
    expect(
      reg
        .list('primary')
        .map((d) => d.name)
        .sort(),
    ).toEqual(['general', 'main'])
  })

  it('later registration overwrites same name', () => {
    const reg = createAgentRegistry()
    reg.register(def('coder', { source: 'builtin' }))
    reg.register(def('coder', { source: 'project', description: 'override' }))
    const got = reg.get('coder')
    expect(got?.source).toBe('project')
    expect(got?.description).toBe('override')
  })

  it('get() returns undefined for unknown name', () => {
    const reg = createAgentRegistry()
    expect(reg.get('nope')).toBeUndefined()
  })
})
