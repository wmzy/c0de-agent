// 全局权限确认 store —— 进程级单例，pending 独立于 agent run 生命周期。
//
// 设计参考 opencode 的 PermissionV2.Service：pending 挂在全局/Service 层，
// reply 按 toolCallId 直接寻址，不依赖 session/agent run 的注册状态。
// 这样即使 agent run 被覆盖、注销或 abort，pending 仍在 store 里，
// confirm 仍能找到并 resolve。

import type { PermissionResult } from '../../tools/types.js'

/** 默认 pending 超时时长：5 分钟（300_000ms）。
 *  超过后自动 resolve 为 deny 并清理 store 条目，避免 promise 永久挂起与 pending Map 泄漏。 */
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

/** 权限请求（需要用户确认）。 */
type PermissionRequest = {
  toolCallId: string
  tool: string
  input: unknown
}

/** 待处理的权限确认。 */
type PendingPermission = {
  request: PermissionRequest
  resolve: (result: PermissionResult) => void
}

/** store 内部条目：在 PendingPermission 之上附带超时定时器句柄，便于终结时 clearTimeout。 */
type StoredPermission = PendingPermission & {
  timer: ReturnType<typeof setTimeout>
}

/** createPermissionStore 的配置。 */
type PermissionStoreOptions = {
  /** pending 超时毫秒数；省略时取 DEFAULT_PERMISSION_TIMEOUT_MS（5 分钟）。 */
  timeoutMs?: number
}

/** 全局权限确认 store：注册/解析 pending permission。 */
type PermissionStore = {
  register(toolCallId: string, pending: PendingPermission): void
  resolve(toolCallId: string, approved: boolean): boolean
  has(toolCallId: string): boolean
  size(): number
}

function createPermissionStore(opts: PermissionStoreOptions = {}): PermissionStore {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
  const pending = new Map<string, StoredPermission>()

  // 统一终结路径：clearTimeout → 删除条目 → resolve。
  // 三处调用（confirm、超时回调、abort 联动）都汇聚于此：
  // 保证 promise 只 settle 一次（resolve 幂等）、定时器必被清理、Map 条目必被释放。
  const settle = (toolCallId: string, result: PermissionResult): boolean => {
    const p = pending.get(toolCallId)
    if (!p) return false
    clearTimeout(p.timer)
    pending.delete(toolCallId)
    p.resolve(result)
    return true
  }

  return {
    register(toolCallId, entry) {
      // 重复注册同 id 时先清理旧定时器，避免旧 timer 泄漏。
      const existing = pending.get(toolCallId)
      if (existing) clearTimeout(existing.timer)

      const timer = setTimeout(() => {
        settle(toolCallId, { _tag: 'deny', reason: 'Permission request timed out' })
      }, timeoutMs)
      pending.set(toolCallId, { ...entry, timer })
    },
    resolve(toolCallId, approved) {
      return settle(
        toolCallId,
        approved ? { _tag: 'allow' } : { _tag: 'deny', reason: 'User denied permission' },
      )
    },
    has(toolCallId) {
      return pending.has(toolCallId)
    },
    size() {
      return pending.size
    },
  }
}

export type {
  PendingPermission,
  PermissionRequest,
  PermissionStore,
  PermissionStoreOptions,
}
export { DEFAULT_PERMISSION_TIMEOUT_MS, createPermissionStore }
