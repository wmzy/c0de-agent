import { apiRequest } from './api.js'

/** GET /api/update 返回体。 */
type UpdateStatus = {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  disabled?: boolean
  /** 热更新影响面：进行中的对话与终端面板（apply 确认框逐项展示）。 */
  impact?: {
    runs: Array<{ sessionId: string; title: string; agentType?: string }>
    terminalCount: number
    terminals: Array<{ id: string; title: string; shell: string; cwd: string }>
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
  apply: () => apiRequest<ApplyResult>('/api/update/apply', { method: 'POST' }),
}

export type { ApplyResult, UpdateStatus }
export { updateAPI }
