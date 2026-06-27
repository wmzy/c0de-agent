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
})
