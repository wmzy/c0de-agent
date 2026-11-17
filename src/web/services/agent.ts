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

/** agent 清单查询键（useAgents 正本；agent 增删后的失效统一走这里）。 */
export function agentsKey() {
  return ['agents'] as const
}

/** agent 清单查询选项：只统一键 + queryFn；staleTime 留给各观察者。 */
export function agentsQueryOptions() {
  return {
    queryKey: agentsKey(),
    queryFn: () => agentAPI.listAgents(),
  }
}
