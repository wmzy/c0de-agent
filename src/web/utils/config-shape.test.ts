/**
 * config-shape 单测：导入/JSON 内容相对当前已解析配置的结构校验与归一化。
 * 对应缺陷：语法合法但结构不对的配置让设置页整页崩进 ErrorBoundary。
 */
import type { Config } from '@shared/types/config.js'
import { describe, expect, it } from 'vitest'
import { normalizeConfigForForm, validateConfigShape } from '@/utils/config-shape.js'

const current = {
  providers: [
    {
      name: 'ProviderA',
      protocol: 'openai',
      baseURL: 'https://api.openai.com/v1',
      models: { 'gpt-4': { enabled: true } },
    },
  ],
  defaultProvider: 'ProviderA',
  defaultModel: 'gpt-4',
  roleRouting: {},
  fallback: { enabled: false, maxRetries: 2, retryDelay: 1000 },
  compaction: { enabled: true, threshold: 0.8, reserveTokens: 1000, keepRecentTokens: 500 },
  tools: { enabled: ['bash', 'read'], disabled: [] },
  plugins: { enabled: ['demo'] },
  mcpServers: [],
  slashCommands: { enabled: ['/model'] },
  theme: 'light',
  toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
  security: { authEnabled: false, allowedOrigins: [] },
  websearch: { provider: 'auto' },
  agents: { subagentConcurrency: 3 },
  permission: { defaultMode: 'default' },
  usage: { monthlyBudgetUsd: 0 },
  update: { enabled: true, intervalMs: 3600000, initialDelayMs: 10000 },
} as unknown as Config

describe('validateConfigShape', () => {
  it('嵌套字段类别不符时给出字段路径（旧实现直接整页崩溃）', () => {
    expect(validateConfigShape({ plugins: { enabled: 'demo' } }, current)).toBe(
      'plugins.enabled：应为数组，实际是字符串',
    )
  })

  it('整段类别不符时报到顶层键', () => {
    expect(validateConfigShape({ tools: 'all' }, current)).toBe('tools：应为对象，实际是字符串')
  })

  it('数组元素类别不符也拦下（错误定位到下标的字段）', () => {
    expect(validateConfigShape({ tools: { enabled: ['read', 3] } }, current)).toBe(
      'tools.enabled[1]：应为字符串，实际是数字',
    )
  })

  it('数组元素对象的字段类别不符时报错（模板取首个现有元素）', () => {
    expect(validateConfigShape({ providers: [{ models: 'gpt-4' }] }, current)).toBe(
      'providers[0].models：应为对象，实际是字符串',
    )
  })

  it('缺失的嵌套键按当前值兜底，不算形状错误', () => {
    expect(validateConfigShape({ tools: { disabled: ['bash'] } }, current)).toBeNull()
  })

  it('顶层未知键按服务端 PATCH 同口径拒绝', () => {
    expect(validateConfigShape({ toolz: {} }, current)).toContain('未知配置键：toolz')
  })

  it('可选顶层键 commitModel 合法', () => {
    expect(validateConfigShape({ commitModel: { provider: 'p', model: 'm' } }, current)).toBeNull()
  })

  it('显式 null 视为「清除该键」，放行', () => {
    expect(validateConfigShape({ compaction: null }, current)).toBeNull()
  })

  it('非对象直接拒绝', () => {
    expect(validateConfigShape([], current)).toBe('配置必须是一个 JSON 对象')
    expect(validateConfigShape('{}', current)).toBe('配置必须是一个 JSON 对象')
    expect(validateConfigShape(null, current)).toBe('配置必须是一个 JSON 对象')
  })

  it('原型链键不被当作合法配置键接受', () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>
    expect(validateConfigShape(raw, current)).toContain('未知配置键：__proto__')
    const result = normalizeConfigForForm(raw, current)
    expect(result.ok).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('normalizeConfigForForm', () => {
  it('补全缺失的嵌套对象键，其余原样保留', () => {
    const result = normalizeConfigForForm({ tools: { disabled: ['bash'] } }, current)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.tools).toEqual({ enabled: ['bash', 'read'], disabled: ['bash'] })
    // 未提及的段完全保留
    expect(result.config.plugins).toEqual({ enabled: ['demo'] })
  })

  it('null 段在表单视角回落到当前值（表单渲染需要完整值）', () => {
    const result = normalizeConfigForForm({ compaction: null, theme: 'dark' }, current)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.compaction).toEqual(current.compaction)
    expect(result.config.theme).toBe('dark')
  })

  it('空对象导入等于保持当前配置（服务端读取即深层兜底）', () => {
    const result = normalizeConfigForForm({}, current)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config).toEqual(current)
  })

  it('数组整体替换：不把模板元素的值填进导入的条目', () => {
    const result = normalizeConfigForForm({ providers: [{ name: 'B' }] }, current)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.providers).toEqual([{ name: 'B' }])
  })

  it('结构不符时返回可展示的原因而不抛错', () => {
    const result = normalizeConfigForForm({ plugins: { enabled: 3 } }, current)
    expect(result).toEqual({ ok: false, message: 'plugins.enabled：应为数组，实际是数字' })
  })

  it('归一化结果可用于渲染：缺失的数组字段已是数组', () => {
    const result = normalizeConfigForForm(JSON.parse('{"tools":{"disabled":["bash"]}}'), current)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Array.isArray(result.config.tools.enabled)).toBe(true)
    expect(Array.isArray(result.config.plugins.enabled)).toBe(true)
    expect(Array.isArray(result.config.slashCommands.enabled)).toBe(true)
  })
})
