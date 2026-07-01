import { apiRequest } from './api.js'

type AgentListItem = {
  name: string
  description: string
  mode: 'subagent' | 'primary' | 'all'
  source: string
  hasTools: boolean
}

const agentAPI = {
  abort: (sessionId: string) =>
    apiRequest<{ aborted: boolean }>('/api/chat/abort', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  pause: (sessionId: string) =>
    apiRequest<{ paused: boolean }>('/api/chat/pause', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  resume: (sessionId: string) =>
    apiRequest<{ resumed: boolean }>('/api/chat/resume', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  steer: (sessionId: string, message: string) =>
    apiRequest<{ steered: boolean }>('/api/chat/steer', {
      method: 'POST',
      body: JSON.stringify({ sessionId, message }),
    }),
  confirmTool: (toolCallId: string, approved: boolean) =>
    apiRequest<{ confirmed: boolean }>('/api/tools/confirm', {
      method: 'POST',
      body: JSON.stringify({ toolCallId, approved }),
    }),
  listAgents: () => apiRequest<{ agents: AgentListItem[] }>('/api/agents', { method: 'GET' }),
}

export type { AgentListItem }
export { agentAPI }
