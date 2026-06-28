import type { LLMDetail } from '@shared/types/agent.js'
import type { Message, Session } from '@shared/types/message.js'
import type { SessionTreeNode } from '../types/index.js'
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
  messages: (id: string) => apiRequest<Message[]>(`/api/sessions/${id}/messages`),
  llmDetails: (id: string) => apiRequest<LLMDetail[]>(`/api/sessions/${id}/llm-details`),
  branches: (id: string) => apiRequest<Session[]>(`/api/sessions/${id}/branches`),
}

export { sessionAPI }
