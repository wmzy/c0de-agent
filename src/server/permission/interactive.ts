import { randomUUID } from 'node:crypto'
import type { ToolContext, ToolDef } from '../../shared/types/tool.js'
import type { PermissionChecker, PermissionResult } from '../../tools/types.js'
import type { PermissionRequest, PermissionStore } from './store.js'

// PermissionRequest 从 store.ts re-export，保持现有 import 路径兼容。
export type { PermissionRequest }

type PermissionMode = 'default' | 'auto'

type InteractivePermissionCheckerOptions = {
  /** 始终允许的工具名（覆盖 permission 字段）。 */
  alwaysAllow?: string[]
  /** 始终拒绝的工具名（覆盖 permission 字段）。 */
  alwaysDeny?: string[]
  /** 读取当前授权模式：'auto' 时跳过 ask 交互确认（YOLO 自动授权）。 */
  getMode?: () => PermissionMode
  /** 遇到 ask 权限时调用（用于通知前端）。 */
  onPermissionRequired?: (request: PermissionRequest) => void | Promise<void>
}

/** 阻塞式权限检查器：ask 权限会阻塞等待用户确认。
 *  pending 存在全局 PermissionStore 中，独立于 agent run 生命周期。 */
type InteractivePermissionChecker = PermissionChecker & {
  confirm(toolCallId: string, approved: boolean): boolean
  hasPending(toolCallId: string): boolean
  pendingCount(): number
}

function createInteractivePermissionChecker(
  store: PermissionStore,
  opts: InteractivePermissionCheckerOptions = {},
): InteractivePermissionChecker {
  const allowSet = new Set(opts.alwaysAllow ?? [])
  const denySet = new Set(opts.alwaysDeny ?? [])

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

      // tool.permission === 'ask'
      // YOLO 自动授权：mode==='auto' 时跳过交互确认直接放行。
      // denySet 与 permission==='deny' 已在上游拦截，故此处只剩 ask 工具。
      if (opts.getMode?.() === 'auto') {
        return { _tag: 'allow' }
      }

      // 交互式确认
      const toolCallId = randomUUID()
      const request: PermissionRequest = { toolCallId, tool: tool.name, input }
      const promise = new Promise<PermissionResult>((resolve) => {
        // pending 注册到全局 store，confirm 端点按 toolCallId 直接寻址，
        // 不依赖当前 agent run 是否仍在 agentManager 中注册。
        store.register(toolCallId, { request, resolve })
      })
      await opts.onPermissionRequired?.(request)
      return promise
    },
    confirm(toolCallId, approved) {
      return store.resolve(toolCallId, approved)
    },
    hasPending(toolCallId) {
      return store.has(toolCallId)
    },
    pendingCount() {
      return store.size()
    },
  }
}

export type { InteractivePermissionChecker, InteractivePermissionCheckerOptions }
export { createInteractivePermissionChecker }
