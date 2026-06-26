import type { ToolDef, ToolResult } from './tool.js'
import type { Message, Session } from './message.js'
import type {
  ChatMessage,
  ChatTool,
  StreamChunk,
  ModelRole,
} from './llm.js'

/** Agent error variants. Discriminated by `_tag`. */
type AgentError =
  | { _tag: 'aborted' }
  | { _tag: 'max_turns'; maxTurns: number }
  | { _tag: 'unexpected'; message: string }
  | { _tag: 'provider'; message: string; retryable: boolean }
  | { _tag: 'tool'; toolName: string; message: string }

/** A tool call awaiting user permission. */
type PendingToolCall = {
  id: string
  tool: string
  input: unknown
}

/** Agent run-time status. Discriminated by `_tag`. */
type AgentStatus =
  | { _tag: 'idle' }
  | { _tag: 'running'; currentTool?: string; turnCount: number }
  | { _tag: 'paused'; pauseReason: string; pendingToolCall?: PendingToolCall }
  | {
      _tag: 'stopped'
      reason: 'completed' | 'aborted' | 'error'
      error?: AgentError
    }

/** Configuration for creating an agent. */
type AgentConfig = {
  provider: string
  model: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  tools: string[]
  plugins: string[]
  maxTurns?: number
}

/** Token budget for context window management. */
type TokenBudget = {
  total: number
  reserved: number
  available: number
  used: number
  keepRecent: number
}

/** Detailed record of a single LLM API call (for transparency/observability). */
type LLMDetail = {
  id: string
  timestamp: number
  model: string
  provider: string
  role: ModelRole
  systemPrompt: string
  messages: ChatMessage[]
  tools: ChatTool[]
  responseChunks: StreamChunk[]
  thinking?: string
  usage: { input: number; output: number; cacheRead?: number }
  latency: { firstToken: number; total: number }
  cost: number
}

/** Events emitted by the agent loop. Discriminated by `_tag`. */
type AgentEvent =
  | { _tag: 'status_change'; status: AgentStatus }
  | { _tag: 'text_delta'; text: string }
  | { _tag: 'tool_call_start'; id: string; tool: string; input: unknown }
  | { _tag: 'tool_call_progress'; id: string; progress: string }
  | { _tag: 'tool_call_end'; id: string; result: ToolResult }
  | {
      _tag: 'tool_calls_parallel'
      calls: { id: string; tool: string; input: unknown }[]
    }
  | { _tag: 'thinking'; text: string }
  | { _tag: 'usage'; input: number; output: number; cacheRead?: number }
  | {
      _tag: 'permission_required'
      toolCallId: string
      tool: string
      input: unknown
    }
  | { _tag: 'error'; error: AgentError }
  | { _tag: 'done' }

/**
 * Mutable agent state.
 * Per the data+functions paradigm, the context object may be modified in place.
 */
type AgentState = {
  id: string
  session: Session
  messages: Message[]
  tools: ToolDef[]
  config: AgentConfig
  status: AgentStatus
  abortController: AbortController
  steeringQueue: string[]
  llmDetails: LLMDetail[]
  tokenBudget: TokenBudget
  compactionModel?: { provider: string; model: string }
}

export type {
  AgentError,
  PendingToolCall,
  AgentStatus,
  AgentConfig,
  TokenBudget,
  LLMDetail,
  AgentEvent,
  AgentState,
}
