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

/** GET /api/workflows/:name 返回的源码视图。 */
type WorkflowDetail = WorkflowInfo & {
  sourceCode: string
}

/** POST /api/workflows 的保存载荷：target 必填（与 REST 路由同口径）。 */
type WorkflowSavePayload = {
  name: string
  source: string
  target: 'project' | 'user'
  /** target=project 时写入选定项目的 worktree；缺省落 serve cwd 项目。 */
  projectId?: string
}

const workflowsAPI = {
  list: (projectId?: string) =>
    apiRequest<{ workflows: WorkflowInfo[] }>(
      projectId ? `/api/workflows?projectId=${encodeURIComponent(projectId)}` : '/api/workflows',
    ),
  get: (name: string, projectId?: string) =>
    apiRequest<WorkflowDetail>(
      `/api/workflows/${encodeURIComponent(name)}${
        projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
      }`,
    ),
  save: (payload: WorkflowSavePayload) =>
    apiRequest<{ ok: boolean; name: string; filePath: string }>('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  remove: (name: string, projectId?: string) =>
    apiRequest<{ ok: boolean }>(
      `/api/workflows/${encodeURIComponent(name)}${
        projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
      }`,
      { method: 'DELETE' },
    ),
}

export type { WorkflowDetail, WorkflowInfo, WorkflowSavePayload }
export { workflowsAPI }
