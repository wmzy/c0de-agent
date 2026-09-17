import { get, post } from '@/services/api.js'

type AgentListItem = {
  name: string
  description: string
  mode: 'subagent' | 'primary' | 'all'
  source: string
  hasTools: boolean
}

const agentAPI = {
  abort: (sessionId: string) => post<{ aborted: boolean }>('/api/chat/abort', { sessionId }),
  pause: (sessionId: string) => post<{ paused: boolean }>('/api/chat/pause', { sessionId }),
  resume: (sessionId: string) => post<{ resumed: boolean }>('/api/chat/resume', { sessionId }),
  steer: (sessionId: string, message: string) =>
    post<{ steered: boolean }>('/api/chat/steer', { sessionId, message }),
  confirmTool: (toolCallId: string, approved: boolean) =>
    post<{ confirmed: boolean }>('/api/tools/confirm', { toolCallId, approved }),
  listAgents: () => get<{ agents: AgentListItem[] }>('/api/agents'),
}

export type { AgentListItem }
export { agentAPI }
