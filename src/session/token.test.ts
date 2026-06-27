import { describe, expect, it } from 'vitest'
import { estimateMessageTokens, estimateTokens } from './token.js'
import type { MessageContent } from '../shared/types/message.js'

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates English text at ~4 chars/token', () => {
    expect(estimateTokens('hello world!')).toBe(3) // 12 chars / 4 = 3
  })

  it('estimates CJK characters at ~2 tokens each', () => {
    // 4 CJK chars → 4 × 2 = 8 tokens
    expect(estimateTokens('你好世界')).toBe(8)
  })

  it('handles mixed CJK and ASCII', () => {
    // '你好' (2 CJK → 4) + 'ab' (2 ASCII → 0.5 → ceil to 1) = 5
    expect(estimateTokens('你好ab')).toBe(5)
  })
})

describe('estimateMessageTokens', () => {
  it('sums tokens across content parts', () => {
    const content: MessageContent[] = [
      { _tag: 'text', text: 'hello' }, // 2
      { _tag: 'thinking', text: 'world' }, // 2
    ]
    expect(estimateMessageTokens(content)).toBe(4)
  })

  it('handles tool_call parts by stringifying input', () => {
    const content: MessageContent[] = [
      { _tag: 'tool_call', id: 't1', tool: 'read', input: { path: '/a.ts' } },
    ]
    expect(estimateMessageTokens(content)).toBeGreaterThan(0)
  })

  it('handles tool_result parts by stringifying output', () => {
    const content: MessageContent[] = [
      {
        _tag: 'tool_result',
        id: 't1',
        tool: 'read',
        output: { _tag: 'success', output: 'file content here' },
      },
    ]
    expect(estimateMessageTokens(content)).toBeGreaterThan(0)
  })

  it('returns 0 for empty content', () => {
    expect(estimateMessageTokens([])).toBe(0)
  })
})
