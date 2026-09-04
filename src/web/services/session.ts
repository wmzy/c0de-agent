import type { LLMSegment } from '@shared/types/agent.js'
import type { Message, Session } from '@shared/types/message.js'
import type { SessionTreeNode, ShakeRegionView } from '../types/index.js'
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
  deleted: () => apiRequest<Session[]>('/api/sessions/deleted'),
  restore: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/sessions/${id}/restore`, { method: 'POST' }),
  messages: (id: string) => apiRequest<Message[]>(`/api/sessions/${id}/messages`),
  llmDetails: (id: string) => apiRequest<LLMSegment[]>(`/api/sessions/${id}/llm-details`),
  compact: (id: string) =>
    apiRequest<{ compacted: boolean; reason?: string }>(`/api/sessions/${id}/compact`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
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
