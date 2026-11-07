// src/server/permission/stream-checker.ts
import type { SSEStreamingApi } from 'hono/streaming'
import type { Config } from '../../core/config.js'
import type { ServerContext } from '../types.js'
import type { InteractivePermissionChecker } from './interactive.js'
import { createInteractivePermissionChecker } from './interactive.js'

type PermissionMode = 'default' | 'auto'
type TimeoutAction = 'pause' | 'deny'

/** 权限确认超时（双层超时兜底）后的动作：仅显式 'deny' 时选 deny，缺省/非法值
 *  一律 pause（安全默认：default 模式下 agent 不在用户缺席时继续自主执行）。
 *  此前三处路由各持一份三元，收敛于此。 */
export function resolvePermissionTimeoutAction(config: Config): TimeoutAction {
  return config.permission.timeoutAction === 'deny' ? 'deny' : 'pause'
}

export type StreamPermissionCheckerOptions = {
  /** SSE 流：ask 权限/超时/过期事件经此通知前端。 */
  stream: SSEStreamingApi
  /** 权限归属与模式查询键 = 用户停留的会话（主 chat = 会话自身；工作流通道 =
   *  发起会话（斜杠）或工作流会话（REST））。子 agent 的 ask 请求统一归属到它，
   *  刷新/切换页面后按当前会话即可重挂挂起弹窗。 */
  sessionId: string
  /** 项目作用域显式默认权限模式（未设置时回退运行时全局模式）。 */
  defaultMode?: PermissionMode
  /** 兜底过期动作（resolvePermissionTimeoutAction 的产物）。 */
  timeoutAction: TimeoutAction
  /** timeoutAction='pause' 时的级联暂停回调（主 run + 全部子 agent run——
   *  仅暂停主 run 会让子 agent 在用户缺席时继续执行）。 */
  onPauseExpired: () => void
}

/**
 * SSE 通道的交互式权限 checker 工厂：主 chat run、斜杠命令流、工作流执行通道
 * 三处此前各持一份完全相同的 createInteractivePermissionChecker 装配
 * （getMode 优先级链 + 4 个 SSE 回调 + timeoutAction 分支），收敛为单点。
 * 差异（归属会话、默认模式、暂停目标）全部经 opts 参数化。
 */
export function createStreamPermissionChecker(
  ctx: ServerContext,
  opts: StreamPermissionCheckerOptions,
): InteractivePermissionChecker {
  const { stream, sessionId } = opts
  return createInteractivePermissionChecker(ctx.permissionStore, {
    getMode: () =>
      ctx.sessionPermissionModes.get(sessionId) ?? opts.defaultMode ?? ctx.permissionMode,
    alwaysAllow: () => ctx.sessionAlwaysAllow.get(sessionId) ?? [],
    reportSessionId: sessionId,
    onPermissionRequired: async (req) => {
      await stream.writeSSE({
        event: 'permission_required',
        data: JSON.stringify({ _tag: 'permission_required', ...req }),
      })
    },
    // 首层确认超时仅通知前端（pending 保持，重开弹窗不重发消息）。
    onPermissionTimeout: (req) => {
      stream
        .writeSSE({
          event: 'permission_timeout',
          data: JSON.stringify({
            _tag: 'permission_timeout',
            ...req,
            timeoutAction: opts.timeoutAction,
          }),
        })
        .catch(() => {})
    },
    // 兜底过期（提示后仍无响应，自动拒绝）：'pause' 时级联暂停 + 通知前端清理
    // 弹窗状态（run 已继续/暂停，重开弹窗/拒绝按钮均失效，必须显式清理）。
    onPermissionExpired: (req) => {
      if (opts.timeoutAction === 'pause') opts.onPauseExpired()
      stream
        .writeSSE({
          event: 'permission_expired',
          data: JSON.stringify({
            _tag: 'permission_expired',
            ...req,
            timeoutAction: opts.timeoutAction,
          }),
        })
        .catch(() => {})
    },
  })
}
