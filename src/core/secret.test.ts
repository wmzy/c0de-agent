import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secret.js'

describe('secret', () => {
  it('加密 → 解密 往返还原明文', () => {
    const plaintext = 'sk-proj-abcdef123456'
    const enc = encryptSecret(plaintext)
    expect(decryptSecret(enc)).toBe(plaintext)
  })

  it('密文带 enc: 前缀', () => {
    expect(isEncryptedSecret(encryptSecret('sk-xxx'))).toBe(true)
    expect(isEncryptedSecret('sk-xxx')).toBe(false)
  })

  it('密文不含明文', () => {
    const plaintext = 'sk-very-secret-key-123'
    const enc = encryptSecret(plaintext)
    expect(enc).not.toContain(plaintext)
    // base64 载荷也不应包含明文子串
    expect(enc).not.toContain('very-secret')
  })

  it('相同明文两次加密 → 密文不同（随机 IV）', () => {
    const a = encryptSecret('sk-same')
    const b = encryptSecret('sk-same')
    expect(a).not.toBe(b)
    // 但都能解密回同一明文
    expect(decryptSecret(a)).toBe('sk-same')
    expect(decryptSecret(b)).toBe('sk-same')
  })

  it('明文（无前缀）原样返回（向后兼容）', () => {
    expect(decryptSecret('sk-legacy-plaintext')).toBe('sk-legacy-plaintext')
  })

  it('空串与特殊字符', () => {
    expect(decryptSecret(encryptSecret(''))).toBe('')
    const weird = 'p@ss:wörd/with=sp@cés'
    expect(decryptSecret(encryptSecret(weird))).toBe(weird)
  })
})
