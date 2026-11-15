import { timingSafeEqual } from 'node:crypto'

/**
 * 恒时字符串比较（单一实现）：认证 token 校验（auth-manager）与热更新 handoff
 * 密钥比对（update/ipc）共用。字符串直接比较可被时序攻击逐字符探测。
 *
 * 长度不等直接 false——timingSafeEqual 要求等长 buffer，先比较长度本身
 * 不泄露内容信息。
 */
export function timingSafeEqualString(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}
