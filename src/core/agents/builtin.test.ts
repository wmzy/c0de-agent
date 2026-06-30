import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from './builtin.js'

describe('BUILTIN_AGENTS', () => {
  it('包含 4 个内置 agent', () => {
    const names = BUILTIN_AGENTS.map((d) => d.name).sort()
    expect(names).toEqual(['coder', 'general', 'researcher', 'reviewer'])
  })

  it('所有内置 agent source 为 builtin', () => {
    for (const def of BUILTIN_AGENTS) {
      expect(def.source).toBe('builtin')
    }
  })

  it('每个内置 agent 有 name/description/systemPrompt/mode', () => {
    for (const def of BUILTIN_AGENTS) {
      expect(def.name).toBeTruthy()
      expect(def.description).toBeTruthy()
      expect(def.systemPrompt).toBeTruthy()
      expect(['subagent', 'primary', 'all']).toContain(def.mode)
    }
  })

  it('researcher 是只读（不含 write/edit/bash）', () => {
    const researcher = BUILTIN_AGENTS.find((d) => d.name === 'researcher')!
    expect(researcher.tools).toBeDefined()
    const tools = researcher.tools!
    expect(tools).toContain('grep')
    expect(tools).toContain('read')
    expect(tools).not.toContain('write')
    expect(tools).not.toContain('bash')
  })

  it('general 允许递归 task（maxRecursion >= 1）', () => {
    const general = BUILTIN_AGENTS.find((d) => d.name === 'general')!
    expect(general.maxRecursion ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('coder/researcher/reviewer 默认禁止递归 task（maxRecursion 0 或缺省）', () => {
    for (const def of BUILTIN_AGENTS) {
      if (def.name === 'general') continue
      expect(def.maxRecursion ?? 0).toBe(0)
    }
  })
})
