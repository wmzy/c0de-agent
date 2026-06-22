// Agent types

import type { LLMProvider, Message } from '../llm'
import type { ToolContext, ToolRegistry } from '../tools'

export interface AgentConfig {
  systemPrompt?: string
  maxIterations?: number
  workingDirectory?: string
}

export interface AgentEvent {
  type: 'message' | 'tool_call' | 'tool_result' | 'done' | 'error'
  data: unknown
}

export interface AgentRunner {
  run(userMessage: string): AsyncGenerator<AgentEvent>
  reset(): void
}
