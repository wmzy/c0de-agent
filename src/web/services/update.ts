import { apiRequest } from './api.js'

/** GET /api/update 返回体。 */
type UpdateStatus = {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
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
