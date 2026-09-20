import { describe, expect, it } from 'vitest'
import { containsSecrets, isSecretKey, maskSecret, redactSecrets } from './redact.js'

/** 孤立代理码元：高代理后不跟低代理，或低代理前不是高代理。 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('isSecretKey', () => {
  it('matches secret-ish key names case-insensitively', () => {
    expect(isSecretKey('apiKey')).toBe(true)
    expect(isSecretKey('api_key')).toBe(true)
    expect(isSecretKey('token')).toBe(true)
    expect(isSecretKey('AUTH_TOKEN')).toBe(true)
    expect(isSecretKey('username')).toBe(false)
    expect(isSecretKey('tokenizer')).toBe(false)
  })
})

describe('maskSecret', () => {
  it('masks short values entirely', () => {
    expect(maskSecret('short')).toBe('****')
    expect(maskSecret(42)).toBe('****')
  })

  it('reveals first/last 4 chars of long values', () => {
    expect(maskSecret('abcdefghij')).toBe('abcd****ghij')
  })

  // 回归：slice(0,4)/slice(-4) 按 UTF-16 码元硬切——切点落在代理对中间时
  // 掩码输出含孤立代理码元，序列化/渲染后损坏为 U+FFFD。
  it('never splits surrogate pairs at the reveal boundary', () => {
    expect(maskSecret('abc😀defg')).toBe('abc****defg')
    expect(maskSecret('abcd😀efgh')).toBe('abcd****efgh')
    expect(LONE_SURROGATE_RE.test(String(maskSecret('abc😀defg')))).toBe(false)
  })
})

describe('redactSecrets', () => {
  it('recursively masks secret-keyed fields', () => {
    const out = redactSecrets({
      name: 'demo',
      apiKey: 'sk-secret-abcdefgh',
      nested: { password: 'pw' },
      list: [{ token: 'tok' }],
    })
    expect(out).toEqual({
      name: 'demo',
      apiKey: 'sk-s****efgh',
      nested: { password: '****' },
      list: [{ token: '****' }],
    })
  })

  it('leaves non-secret structure intact', () => {
    expect(redactSecrets({ a: 1, b: [true] })).toEqual({ a: 1, b: [true] })
  })
})

describe('containsSecrets', () => {
  it('detects non-empty secret values', () => {
    expect(containsSecrets({ providers: [{ apiKey: 'x' }] })).toBe(true)
  })

  it('ignores empty/absent secret values', () => {
    expect(containsSecrets({ apiKey: '' })).toBe(false)
    expect(containsSecrets({ name: 'x' })).toBe(false)
  })
})
