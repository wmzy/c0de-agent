import type { LLMSegment } from '@shared/types/agent.js'
import type { Message, Session } from '@shared/types/message.js'
import type {
  CompactionArchive,
  SessionExport,
  SessionTreeNode,
  ShakeRegionView,
} from '../types/index.js'
import { apiRequest } from './api.js'

const sessionAPI = {
  list: () => apiRequest<Session[]>('/api/sessions'),
  tree: () => apiRequest<SessionTreeNode[]>('/api/sessions/tree'),
  get: (id: string) => apiRequest<Session>(`/api/sessions/${id}`),
  create: (params?: { title?: string; directory?: string; projectId?: string }) =>
    apiRequest<Session>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(params ?? {}),
    }),
  fork: (id: string, messageIndex: number) =>
    apiRequest<Session>(`/api/sessions/${id}/fork`, {
      method: 'POST',
      body: JSON.stringify({ messageIndex }),
    }),
  remove: (id: string) => apiRequest<void>(`/api/sessions/${id}`, { method: 'DELETE' }),
  deleted: (projectId?: string) =>
    apiRequest<Session[]>(
      `/api/sessions/deleted${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  restore: (id: string, projectId?: string) =>
    apiRequest<{ ok: boolean; rebound?: boolean; orphaned?: boolean }>(
      `/api/sessions/${id}/restore`,
      { method: 'POST', body: JSON.stringify(projectId ? { projectId } : {}) },
    ),
  /** 孤儿会话归属到指定项目（P1-2）。 */
  rebind: (id: string, projectId: string) =>
    apiRequest<{ ok: boolean; projectId: string }>(`/api/sessions/${id}/rebind`, {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    }),
  messages: (id: string) => apiRequest<Message[]>(`/api/sessions/${id}/messages`),
  llmDetails: (id: string) => apiRequest<LLMSegment[]>(`/api/sessions/${id}/llm-details`),
  compact: (id: string) =>
    apiRequest<{ compacted: boolean; reason?: string }>(`/api/sessions/${id}/compact`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  /** 彻底删除回收站会话（不可恢复）。 */
  removeForever: (id: string) =>
    apiRequest<{ ok: boolean; deleted: number }>(`/api/sessions/${id}/forever`, {
      method: 'DELETE',
    }),
  /** 清空回收站（不可恢复）；projectId 提供时仅清空该项目。 */
  emptyTrash: (projectId?: string) =>
    apiRequest<{ ok: boolean; deleted: number }>(
      `/api/sessions/deleted${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'DELETE' },
    ),
  /** 会话归档列表（compaction/squash/shake/clear 原始内容）；q 为搜索词。 */
  archives: (id: string, q?: string) =>
    apiRequest<{ archives: CompactionArchive[] }>(
      `/api/sessions/${id}/archives${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    ),
  /** 会话重命名（P2-5）。 */
  rename: (id: string, title: string) =>
    apiRequest<{ ok: boolean; title: string }>(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  /** 会话导出（元数据 + 消息 + 归档），数据可迁移。 */
  exportSession: (id: string) => apiRequest<SessionExport>(`/api/sessions/${id}/export`),
  /** 会话导入（导出的逆操作；绑定 projectId 后出现在对应项目视图）。 */
  importSession: (
    data: unknown,
    projectId?: string,
  ): Promise<{ ok: boolean; sessionId: string; messageCount: number; archiveCount: number }> =>
    apiRequest('/api/sessions/import', {
      method: 'POST',
      body: JSON.stringify({
        ...(data as Record<string, unknown>),
        ...(projectId ? { projectId } : {}),
      }),
    }),
  /** 跨会话搜索（P2-6）：标题 + 消息内容。 */
  search: (q: string, projectId?: string) =>
    apiRequest<{ results: Array<{ session: Session; matchedBy: 'title' | 'content' }> }>(
      `/api/sessions/search?q=${encodeURIComponent(q)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  branches: (id: string) => apiRequest<Session[]>(`/api/sessions/${id}/branches`),
  status: (id: string) => apiRequest<{ _tag: string }>(`/api/sessions/${id}/status`),
  open: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/sessions/${id}/open`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  shakePreview: (id: string) =>
    apiRequest<{ regions: ShakeRegionView[] }>(`/api/sessions/${id}/shake/preview`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  shakeApply: (id: string, regionIds: string[]) =>
    apiRequest<{ shaken: number; archiveId: string }>(`/api/sessions/${id}/shake/apply`, {
      method: 'POST',
      body: JSON.stringify({ regionIds }),
    }),
}

export { sessionAPI }
