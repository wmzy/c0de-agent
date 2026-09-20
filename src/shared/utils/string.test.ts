import { describe, expect, it } from 'vitest'
import { headChars, tailChars } from './string.js'

/** 孤立代理码元：高代理后不跟低代理，或低代理前不是高代理。 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('headChars', () => {
  it('returns full text when n >= length', () => {
    expect(headChars('ab😀c', 5)).toBe('ab😀c')
    expect(headChars('ab😀c', 99)).toBe('ab😀c')
  })

  it('returns empty for n <= 0', () => {
    expect(headChars('abc', 0)).toBe('')
    expect(headChars('abc', -1)).toBe('')
  })

  it('cuts at an exact boundary when it does not split a pair', () => {
    expect(headChars('ab😀cd', 4)).toBe('ab😀')
    expect(headChars('abcd', 2)).toBe('ab')
  })

  it('retracts the cut when it splits a surrogate pair', () => {
    expect(headChars('a😀b', 2)).toBe('a')
    expect(headChars('ab😀cd', 3)).toBe('ab')
    expect(LONE_SURROGATE_RE.test(headChars('a😀b', 2))).toBe(false)
  })
})

describe('tailChars', () => {
  it('returns full text when n >= length', () => {
    expect(tailChars('a😀bc', 5)).toBe('a😀bc')
    expect(tailChars('a😀bc', 99)).toBe('a😀bc')
  })

  it('returns empty for n <= 0', () => {
    expect(tailChars('abc', 0)).toBe('')
    expect(tailChars('abc', -1)).toBe('')
  })

  it('cuts at an exact boundary when it does not split a pair', () => {
    expect(tailChars('ab😀cd', 2)).toBe('cd')
    expect(tailChars('abcd', 2)).toBe('cd')
  })

  it('skips a leading lone low surrogate when the cut splits a pair', () => {
    // 'a😀bc' 长度 5：n=3 → 切点 2 落在代理对(H@1,L@2)中间 → 右移到 3 → 'bc'
    expect(tailChars('a😀bc', 3)).toBe('bc')
    expect(LONE_SURROGATE_RE.test(tailChars('a😀bc', 3))).toBe(false)
    // 无拆分时不右移：n=2 → 切点 3 在 L 之后 → 'bc' 原样
    expect(tailChars('a😀bc', 2)).toBe('bc')
  })
})
