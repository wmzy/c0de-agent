// 全局权限确认 store —— 进程级单例，pending 独立于 agent run 生命周期。
//
// 设计参考 opencode 的 PermissionV2.Service：pending 挂在全局/Service 层，
// reply 按 toolCallId 直接寻址，不依赖 session/agent run 的注册状态。
// 这样即使 agent run 被覆盖、注销或 abort，pending 仍在 store 里，
// confirm 仍能找到并 resolve。

import type { PermissionResult } from '../../tools/types.js'

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

/** 全局权限确认 store：注册/解析 pending permission。 */
type PermissionStore = {
  register(toolCallId: string, pending: PendingPermission): void
  resolve(toolCallId: string, approved: boolean): boolean
  has(toolCallId: string): boolean
  size(): number
}

function createPermissionStore(): PermissionStore {
  const pending = new Map<string, PendingPermission>()

  return {
    register(toolCallId, p) {
      pending.set(toolCallId, p)
    },
    resolve(toolCallId, approved) {
      const p = pending.get(toolCallId)
      if (!p) return false
      pending.delete(toolCallId)
      p.resolve(approved ? { _tag: 'allow' } : { _tag: 'deny', reason: 'User denied permission' })
      return true
    },
    has(toolCallId) {
      return pending.has(toolCallId)
    },
    size() {
      return pending.size
    },
  }
}

export type { PendingPermission, PermissionRequest, PermissionStore }
export { createPermissionStore }
