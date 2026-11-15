import { del, get, post, put } from '@/services/api.js'
import { broadcastOnChannel, subscribeChannel } from '@/utils/broadcast.js'

/** 授权模式：'default' 逐个确认，'auto' 自动放行 ask 工具（YOLO）。 */
type PermissionMode = 'default' | 'auto'

/** 会话权限状态（GET /api/permissions/:sessionId；全局 GET 无 alwaysAllow）。 */
type SessionPermissionState = {
  mode: PermissionMode
  alwaysAllow?: string[]
}

/** P1-5：模式按会话隔离。sessionId 提供时读写该会话覆盖，否则默认模式。 */
const permissionAPI = {
  getMode: (sessionId?: string) =>
    get<SessionPermissionState>(
      sessionId ? `/api/permissions/${encodeURIComponent(sessionId)}` : '/api/permissions',
    ),
  setMode: (mode: PermissionMode, sessionId?: string) =>
    put<{ mode: PermissionMode }>(
      sessionId ? `/api/permissions/${encodeURIComponent(sessionId)}` : '/api/permissions',
      { mode },
    ),
  /** 会话级「始终允许」白名单：追加工具（幂等）。 */
  setAlwaysAllow: (tool: string, sessionId: string) =>
    post<{ alwaysAllow: string[] }>(
      `/api/permissions/${encodeURIComponent(sessionId)}/always-allow`,
      { tool },
    ),
  /** 从会话级白名单移除工具。 */
  removeAlwaysAllow: (tool: string, sessionId: string) =>
    del<{ alwaysAllow: string[] }>(
      `/api/permissions/${encodeURIComponent(sessionId)}/always-allow/${encodeURIComponent(tool)}`,
    ),
}

/** 跨标签页同步频道（P1-5：同一会话在多个标签页打开时模式变更互相同步）。 */
const MODE_CHANNEL = 'c0de-permission-mode'

type ModeChangeMessage = { sessionId: string | null; mode: PermissionMode }

function broadcastModeChange(msg: ModeChangeMessage): void {
  broadcastOnChannel(MODE_CHANNEL, msg)
}

/** 订阅其他标签页的模式变更。返回取消订阅函数。 */
function subscribeModeChange(
  sessionId: string | null,
  handler: (mode: PermissionMode) => void,
): () => void {
  // 频道骨架（SSR 守卫/onmessage/关闭）在 subscribeChannel；按会话过滤是本频道
  // 的语义（mode 频道广播所有会话的变更，非本会话的不动），留在调用方。
  return subscribeChannel<ModeChangeMessage>(MODE_CHANNEL, (msg) => {
    if (msg && msg.sessionId === sessionId) handler(msg.mode)
  })
}

export type { ModeChangeMessage, PermissionMode, SessionPermissionState }
export { broadcastModeChange, permissionAPI, subscribeModeChange }
