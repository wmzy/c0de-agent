// diffConfig / isPatchEmpty 单测：Settings 保存只提交最小 patch（P1-2 作用域污染修复）。

import { describe, expect, it } from 'vitest'
import { diffConfig, isPatchEmpty, restoreClearedSecrets } from '@/utils/config-diff.js'

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

describe('restoreClearedSecrets', () => {
  it('provider 的 apiKey 被清空时退回已保存的密文，且 diff 为空', () => {
    const saved = {
      providers: [{ name: 'A', apiKey: 'enc:AAAA', baseURL: 'https://a/v1' }],
    }
    const draft = { providers: [{ name: 'A', apiKey: '', baseURL: 'https://a/v1' }] }
    const { draft: next, restored } = restoreClearedSecrets(saved, draft)
    expect(restored).toBe(1)
    expect((next.providers as { apiKey: string }[])[0]?.apiKey).toBe('enc:AAAA')
    expect(diffConfig(saved, next)).toEqual({})
    // 原草稿不被就地改写
    expect((draft.providers as { apiKey: string }[])[0]?.apiKey).toBe('')
  })

  it('非空的新密钥照常提交（不退回）', () => {
    const saved = { providers: [{ name: 'A', apiKey: 'enc:AAAA' }] }
    const draft = { providers: [{ name: 'A', apiKey: 'sk-new' }] }
    const { draft: next, restored } = restoreClearedSecrets(saved, draft)
    expect(restored).toBe(0)
    expect((next.providers as { apiKey: string }[])[0]?.apiKey).toBe('sk-new')
  })

  it('同名行的下标已错位（删掉一行再新增）时不把上一行的密文塞给新行', () => {
    const saved = {
      providers: [
        { name: 'A', apiKey: 'enc:AAAA' },
        { name: 'B', apiKey: 'enc:BBBB' },
      ],
    }
    const draft = {
      providers: [
        { name: 'B', apiKey: 'enc:BBBB' },
        { name: 'New', apiKey: '' },
      ],
    }
    const { draft: next, restored } = restoreClearedSecrets(saved, draft)
    expect(restored).toBe(0)
    expect((next.providers as { apiKey: string }[])[1]?.apiKey).toBe('')
  })

  it('websearch 的两个 key 同样按「留空 = 不修改」处理', () => {
    const saved = { websearch: { provider: 'tavily', tavilyApiKey: 'enc:T', braveApiKey: 'enc:B' } }
    const draft = { websearch: { provider: 'tavily', tavilyApiKey: '', braveApiKey: '' } }
    const { draft: next, restored } = restoreClearedSecrets(saved, draft)
    expect(restored).toBe(2)
    expect(next.websearch).toEqual({
      provider: 'tavily',
      tavilyApiKey: 'enc:T',
      braveApiKey: 'enc:B',
    })
  })

  it('已保存值本就是空时不算「退回」（新填的空 key 保持空）', () => {
    const saved = { providers: [{ name: 'A', apiKey: '' }] }
    const draft = { providers: [{ name: 'A', apiKey: '' }] }
    expect(restoreClearedSecrets(saved, draft).restored).toBe(0)
  })
})
