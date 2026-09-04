import { apiRequest } from './api.js'

/** 授权模式：'default' 逐个确认，'auto' 自动放行 ask 工具（YOLO）。 */
type PermissionMode = 'default' | 'auto'

/** P1-5：模式按会话隔离。sessionId 提供时读写该会话覆盖，否则默认模式。 */
const permissionAPI = {
  getMode: (sessionId?: string) =>
    apiRequest<{ mode: PermissionMode }>(
      sessionId ? `/api/permissions/${encodeURIComponent(sessionId)}` : '/api/permissions',
    ),
  setMode: (mode: PermissionMode, sessionId?: string) =>
    apiRequest<{ mode: PermissionMode }>(
      sessionId ? `/api/permissions/${encodeURIComponent(sessionId)}` : '/api/permissions',
      {
        method: 'PUT',
        body: JSON.stringify({ mode }),
      },
    ),
}

/** 跨标签页同步频道（P1-5：同一会话在多个标签页打开时模式变更互相同步）。 */
const MODE_CHANNEL = 'c0de-permission-mode'

type ModeChangeMessage = { sessionId: string | null; mode: PermissionMode }

function broadcastModeChange(msg: ModeChangeMessage): void {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return
  try {
    const ch = new BroadcastChannel(MODE_CHANNEL)
    ch.postMessage(msg)
    ch.close()
  } catch {
    // BroadcastChannel 不可用：忽略（无跨标签页同步）
  }
}

/** 订阅其他标签页的模式变更。返回取消订阅函数。 */
function subscribeModeChange(
  sessionId: string | null,
  handler: (mode: PermissionMode) => void,
): () => void {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return () => {}
  const ch = new BroadcastChannel(MODE_CHANNEL)
  ch.onmessage = (ev: MessageEvent<ModeChangeMessage>) => {
    const msg = ev.data
    if (msg && msg.sessionId === sessionId) handler(msg.mode)
  }
  return () => ch.close()
}

export type { ModeChangeMessage, PermissionMode }
export { broadcastModeChange, permissionAPI, subscribeModeChange }
