// src/server/permission/interactive.ts
import { randomUUID } from 'node:crypto'
import type { ToolContext, ToolDef } from '../../shared/types/tool.js'
import type { PermissionChecker, PermissionResult } from '../../tools/types.js'

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

type InteractivePermissionCheckerOptions = {
  /** 始终允许的工具名（覆盖 permission 字段）。 */
  alwaysAllow?: string[]
  /** 始终拒绝的工具名（覆盖 permission 字段）。 */
  alwaysDeny?: string[]
  /** 遇到 ask 权限时调用（用于通知前端）。 */
  onPermissionRequired?: (request: PermissionRequest) => void | Promise<void>
}

/** 阻塞式权限检查器：ask 权限会阻塞等待用户确认。 */
type InteractivePermissionChecker = PermissionChecker & {
  confirm(toolCallId: string, approved: boolean): boolean
  hasPending(toolCallId: string): boolean
  pendingCount(): number
}

function createInteractivePermissionChecker(
  opts: InteractivePermissionCheckerOptions = {},
): InteractivePermissionChecker {
  const allowSet = new Set(opts.alwaysAllow ?? [])
  const denySet = new Set(opts.alwaysDeny ?? [])
  const pending = new Map<string, PendingPermission>()

  return {
    check: async (tool: ToolDef, input: unknown, _ctx: ToolContext): Promise<PermissionResult> => {
      if (denySet.has(tool.name)) {
        return { _tag: 'deny', reason: `Tool "${tool.name}" is denied by configuration` }
      }
      if (allowSet.has(tool.name) || tool.permission === 'auto') {
        return { _tag: 'allow' }
      }
      if (tool.permission === 'deny') {
        return { _tag: 'deny', reason: `Tool "${tool.name}" is disabled` }
      }

      // tool.permission === 'ask' — 交互式确认
      const toolCallId = randomUUID()
      const request: PermissionRequest = { toolCallId, tool: tool.name, input }
      const promise = new Promise<PermissionResult>((resolve) => {
        pending.set(toolCallId, { request, resolve })
      })
      await opts.onPermissionRequired?.(request)
      return promise
    },
    confirm(toolCallId, approved) {
      const p = pending.get(toolCallId)
      if (!p) return false
      pending.delete(toolCallId)
      p.resolve(approved ? { _tag: 'allow' } : { _tag: 'deny', reason: 'User denied permission' })
      return true
    },
    hasPending(toolCallId) {
      return pending.has(toolCallId)
    },
    pendingCount() {
      return pending.size
    },
  }
}

export type { InteractivePermissionChecker, InteractivePermissionCheckerOptions, PermissionRequest }
export { createInteractivePermissionChecker }
