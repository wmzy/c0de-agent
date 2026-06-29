import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { hostname, userInfo } from 'node:os'

/** 加密值的存储前缀。无此前缀的值视为明文（向后兼容）。 */
const PREFIX = 'enc:'
/** 密钥派生盐（固定；机器绑定由 hostname+username 提供）。 */
const SALT = 'c0de-agent-apikey-v1'

/** 机器标识，用于派生加密密钥。userInfo 失败时回退到环境变量。 */
function machineId(): string {
  try {
    return `${hostname()}:${userInfo().username}`
  } catch {
    return `${hostname()}:${process.env.USER ?? 'anonymous'}`
  }
}

/** 派生 256 位 AES 密钥（机器绑定）。 */
function deriveKey(): Buffer {
  return scryptSync(machineId(), SALT, 32)
}

/** 判断存储值是否已加密（带 enc: 前缀）。 */
export function isEncryptedSecret(stored: string): boolean {
  return stored.startsWith(PREFIX)
}

/**
 * 加密一个敏感值（如 provider apiKey），返回 `enc:` 前缀的 base64 串。
 * 使用 AES-256-GCM + 随机 IV + 机器绑定密钥（spec §24.2「keyring 或加密文件」）。
 * 机器绑定意味着密文不可跨机器解密——apiKey 本就该在各机器重新配置。
 */
export function encryptSecret(plaintext: string): string {
  const key = deriveKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64')
}

/**
 * 解密存储值。带 `enc:` 前缀则解密；否则原样返回（明文兼容，平滑迁移）。
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored
  const buf = Buffer.from(stored.slice(PREFIX.length), 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const key = deriveKey()
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
