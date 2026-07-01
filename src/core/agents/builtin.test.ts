import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from './builtin.js'

describe('BUILTIN_AGENTS', () => {
  it('包含 6 个内置 agent（4 subagent + 2 primary）', () => {
    const names = BUILTIN_AGENTS.map((d) => d.name).sort()
    expect(names).toEqual(['coder', 'default', 'general', 'plan', 'researcher', 'reviewer'])
  })

  it('所有内置 agent source 为 builtin', () => {
    for (const def of BUILTIN_AGENTS) {
      expect(def.source).toBe('builtin')
    }
  })

  it('每个内置 agent 有 name/description', () => {
    for (const def of BUILTIN_AGENTS) {
      expect(def.name).toBeTruthy()
      expect(def.description).toBeTruthy()
    }
  })

  it('default 和 plan 是 primary 模式', () => {
    const primaryAgents = BUILTIN_AGENTS.filter((d) => d.mode === 'primary')
    expect(primaryAgents.map((d) => d.name).sort()).toEqual(['default', 'plan'])
  })

  it('default 的 systemPrompt 为空（走默认 role）', () => {
    const def = BUILTIN_AGENTS.find((d) => d.name === 'default')
    expect(def?.systemPrompt).toBe('')
  })

  it('plan 限定只读工具集', () => {
    const plan = BUILTIN_AGENTS.find((d) => d.name === 'plan')
    expect(plan?.tools).toEqual(['read', 'grep', 'glob', 'bash'])
    expect(plan?.systemPrompt).toContain('Plan Mode')
  })

  it('researcher 是只读（不含 write/edit/bash）', () => {
    const researcher = BUILTIN_AGENTS.find((d) => d.name === 'researcher')
    expect(researcher).toBeDefined()
    const tools = researcher?.tools
    expect(tools).toBeDefined()
    expect(tools).not.toContain('write')
    expect(tools).not.toContain('edit')
  })

  it('general 允许递归 task（maxRecursion >= 1）', () => {
    const general = BUILTIN_AGENTS.find((d) => d.name === 'general')
    expect(general).toBeDefined()
    expect(general?.maxRecursion ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('coder/researcher/reviewer 默认禁止递归 task（maxRecursion 0 或缺省）', () => {
    for (const def of BUILTIN_AGENTS) {
      if (def.name === 'general') continue
      if (def.mode === 'primary') continue
      expect(def.maxRecursion ?? 0).toBe(0)
    }
  })
})
