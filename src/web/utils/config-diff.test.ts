// diffConfig / isPatchEmpty 单测：Settings 保存只提交最小 patch（P1-2 作用域污染修复）。

import { describe, expect, it } from 'vitest'
import { diffConfig, isPatchEmpty } from './config-diff.js'

describe('diffConfig', () => {
  it('无变化返回空 patch', () => {
    const base = { a: 1, nested: { b: 'x', c: [1, 2] } }
    expect(diffConfig(base, { ...base, nested: { ...base.nested } })).toEqual({})
    expect(isPatchEmpty({})).toBe(true)
  })

  it('只包含变化的键，未变的顶层键不出现', () => {
    const base = {
      defaultModel: 'a',
      security: { authEnabled: true },
      tools: { enabled: ['read'] },
    }
    const next = {
      ...base,
      defaultModel: 'b',
      security: { authEnabled: true },
      tools: { enabled: ['read'] },
    }
    expect(diffConfig(base, next)).toEqual({ defaultModel: 'b' })
  })

  it('嵌套对象递归 diff，数组整体比较', () => {
    const base = { compaction: { threshold: 0.8, reserveTokens: 1000 }, providers: [{ name: 'A' }] }
    const next = {
      compaction: { threshold: 0.9, reserveTokens: 1000 },
      providers: [{ name: 'B' }],
    }
    expect(diffConfig(base, next)).toEqual({
      compaction: { threshold: 0.9 },
      providers: [{ name: 'B' }],
    })
  })

  it('undefined 值（删除）→ null unset 标记', () => {
    const base = { compaction: { threshold: 0.8, compactionModel: { provider: 'P' } } }
    const next = { compaction: { threshold: 0.8, compactionModel: undefined } }
    expect(diffConfig(base, next)).toEqual({ compaction: { compactionModel: null } })
  })

  it('base 中不存在于 next 的键 → null unset', () => {
    const base = { a: 1, b: 2 }
    const next = { a: 1 }
    expect(diffConfig(base, next)).toEqual({ b: null })
  })

  it('isPatchEmpty 递归判定', () => {
    expect(isPatchEmpty({ nested: {} })).toBe(true)
    expect(isPatchEmpty({ nested: { x: {} } })).toBe(true)
    expect(isPatchEmpty({ nested: { x: 1 } })).toBe(false)
  })
})
