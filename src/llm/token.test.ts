import { describe, expect, it } from 'vitest'
import { estimateTokens } from './token.js'

describe('token estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('hello world!')).toBe(3) // 12 chars / 4
  })

  it('rounds up', () => {
    expect(estimateTokens('abcde')).toBe(2) // 5 chars → ceil(1.25)
  })

  // CJK 感知回归：本模块与 session/token 曾是两套独立实现，本模块把中文按
  // 「4 字符 1 token」估算（中文实际约 1 字符 2 token），低估 ~8 倍——
  // 同一字符串在两处给出不同估算，预算/压缩口径随调用点漂移。
  it('estimates CJK characters at ~2 tokens each', () => {
    expect(estimateTokens('你好世界')).toBe(8)
  })

  it('handles mixed CJK and ASCII', () => {
    expect(estimateTokens('你好ab')).toBe(5)
  })
})
