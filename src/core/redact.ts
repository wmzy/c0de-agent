/**
 * 敏感字段脱敏工具：/config 斜杠命令与 `c0de config get` 展示配置时使用，
 * 防止 apiKey / token 等明文出现在聊天界面或终端输出中。
 */

/** 敏感字段名模式（大小写不敏感，匹配完整键名）。 */
const SECRET_KEY_RE = /(api[_-]?key|token|password|passwd|secret|authorization|auth[_-]?token)$/i

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key)
}

/** 掩码敏感值：短值整体掩码；长值保留首尾各 4 位。非字符串统一返回 ****。 */
export function maskSecret(value: unknown): unknown {
  if (typeof value !== 'string') return '****'
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}****${value.slice(-4)}`
}

/** 递归脱敏：键名命中敏感模式的字段被掩码，其余结构原样保留。 */
export function redactSecrets(value: unknown, key?: string): unknown {
  if (typeof key === 'string' && isSecretKey(key)) return maskSecret(value)
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecrets(v, k)
    }
    return out
  }
  return value
}

/** 判断对象树中是否含非空敏感值（用于「配置文件含密钥」类警告）。 */
export function containsSecrets(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => containsSecrets(v))
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) {
        if (typeof v === 'string' ? v.length > 0 : v != null) return true
        continue
      }
      if (containsSecrets(v)) return true
    }
  }
  return false
}
