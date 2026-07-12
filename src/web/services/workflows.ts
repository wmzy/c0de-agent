import { apiRequest } from './api.js'

/** GET /api/workflows 返回的工作流条目。 */
type WorkflowInfo = {
  name: string
  description: string
  argsHint?: string
  phases?: string[]
  source: string
}

const workflowsAPI = {
  list: () => apiRequest<{ workflows: WorkflowInfo[] }>('/api/workflows'),
}

export type { WorkflowInfo }
export { workflowsAPI }
