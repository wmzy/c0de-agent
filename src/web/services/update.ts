import { apiRequest } from './api.js'

/** GET /api/update 返回体。 */
type UpdateStatus = {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  disabled?: boolean
  /** 热更新影响面：进行中的对话与终端面板（apply 确认框逐项展示）。 */
  impact?: {
    runs: Array<{
      sessionId: string
      title: string
      agentType?: string
      /** P2-9：run 状态（running/paused/…），currentTool 非空 = 正在执行工具。 */
      status?: string
      currentTool?: string
    }>
    terminalCount: number
    terminals: Array<{ id: string; title: string; shell: string; cwd: string; command?: string }>
    /** P3-9：等待确认的权限请求数（更新后弹窗失效、按拒绝处理）。 */
    pendingPermissionCount?: number
  }
}

/** POST /api/update/apply 成功响应。 */
type ApplyResult = {
  ok: boolean
  snapshotPath: string
  latestVersion: string
}

const updateAPI = {
  status: () => apiRequest<UpdateStatus>('/api/update'),
  apply: (rerunTerminalIds?: string[]) =>
    apiRequest<ApplyResult>('/api/update/apply', {
      method: 'POST',
      body: JSON.stringify({ rerunTerminalIds: rerunTerminalIds ?? [] }),
    }),
}

export type { ApplyResult, UpdateStatus }
export { updateAPI }
