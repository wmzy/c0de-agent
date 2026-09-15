import { apiRequest } from './api.js'

/** GET /api/workflows 返回的工作流条目。 */
type WorkflowInfo = {
  name: string
  description: string
  argsHint?: string
  phases?: string[]
  source: string
  /** 项目级工作流同名覆盖了内置（builtin）或用户（user）工作流时非空。 */
  overrides?: 'builtin' | 'user' | null
}

const workflowsAPI = {
  list: (projectId?: string) =>
    apiRequest<{ workflows: WorkflowInfo[] }>(
      projectId ? `/api/workflows?projectId=${encodeURIComponent(projectId)}` : '/api/workflows',
    ),
}

export type { WorkflowInfo }
export { workflowsAPI }
