// diffConfig / isPatchEmpty 单测：Settings 保存只提交最小 patch（P1-2 作用域污染修复）。

import { describe, expect, it } from 'vitest'
import {
  diffConfig,
  isPatchEmpty,
  restoreClearedSecrets,
  tagProviderRowIds,
} from '@/utils/config-diff.js'

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

  /**
   * 改名不能毁掉密钥。
   *
   * 缺陷：配对判据是「同下标 + 同名」，而名字恰恰是最常改的字段。给已有 provider
   * 改个名再保存 → 改名行 apiKey 是空串、配不上原行 → diff 写出 `apiKey: ''` →
   * 服务端只加密非空明文，空串覆盖密文，密钥永久丢失，界面还回「✓ 已保存」。
   *
   * 修法：已加载配置的行带 PROVIDER_ROW_ID 标记，编辑是 `{…row}` 展开、标记跟着走，
   * 于是改名后的行按**身份**认回原行。
   */
  it('provider 改名后（带行身份标记）密钥仍退回，diff 里只有名字变了', () => {
    const saved = { providers: [{ name: 'openai', apiKey: 'enc:AAAA' }] }
    tagProviderRowIds(saved.providers)
    // 真实编辑路径：密钥框里敲过又清空（留空 = 不修改），随后顺手改了名——
    // 行是 `{...原行, name: '新名', apiKey: ''}` 展开出来的，标记随之复制。
    const renamed = { ...(saved.providers[0] as object), name: 'openai-main', apiKey: '' }
    const draft = { providers: [renamed] }

    const { draft: next, restored } = restoreClearedSecrets(saved, draft)
    expect(restored).toBe(1)
    expect((next.providers as { apiKey: string }[])[0]?.apiKey).toBe('enc:AAAA')
    // 数组是整体比较的，改名会把整行写进 patch——关键是里面带着原密文，不是空串。
    const patch = diffConfig(saved, next) as { providers: { name: string; apiKey: string }[] }
    expect(patch.providers[0]?.apiKey).toBe('enc:AAAA')
    expect(patch.providers[0]?.name).toBe('openai-main')
  })

  it('改名 + 换 URL 也算同一行（身份标记不依赖任何字段的值）', () => {
    const saved = {
      providers: [{ name: 'a', apiKey: 'enc:AAAA', baseURL: 'https://old/v1' }],
    }
    tagProviderRowIds(saved.providers)
    const draft = {
      providers: [
        { ...(saved.providers[0] as object), name: 'b', baseURL: 'https://new/v1', apiKey: '' },
      ],
    }
    const { draft: next, restored } = restoreClearedSecrets(saved, draft)
    expect(restored).toBe(1)
    expect((next.providers as { apiKey: string }[])[0]?.apiKey).toBe('enc:AAAA')
  })

  it('已保存行带标记时，同名但没标记的新行不继承密文', () => {
    const saved = {
      providers: [
        { name: 'A', apiKey: 'enc:AAAA' },
        { name: 'B', apiKey: 'enc:BBBB' },
      ],
    }
    tagProviderRowIds(saved.providers)
    // 删掉第一行后新增一行（新行是全新对象：展开自空 provider，不是已保存行）。
    const draft = {
      providers: [
        { ...(saved.providers[1] as object) },
        { name: 'B', apiKey: '', protocol: 'openai-compat' },
      ],
    }
    const { draft: next, restored } = restoreClearedSecrets(saved, draft)
    expect(restored).toBe(0)
    expect((next.providers as { apiKey: string }[])[1]?.apiKey).toBe('')
  })
})
