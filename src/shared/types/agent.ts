import type { ChatMessage, ChatTool, ModelRole, StreamChunk } from './llm.js'
import type { Message, Session } from './message.js'
import type { ToolDef, ToolResult } from './tool.js'

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

/**
 * Token budget for context window management.
 * 分配（spec §3.6 策略1）：reserved(system prompt+工具描述) 20%，
 * historyBudget(历史消息) 60%，剩余 available-historyBudget 预留给当前轮次 20%。
 */
type TokenBudget = {
  total: number
  reserved: number
  available: number
  historyBudget: number
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
  /** 模型上下文窗口大小（token），来自 registry capabilities。用于总结面板的使用率。 */
  contextWindow?: number
}

/** Events emitted by the agent loop. Discriminated by `_tag`. */
type AgentEvent =
  | { _tag: 'status_change'; status: AgentStatus }
  | { _tag: 'text_delta'; text: string }
  | { _tag: 'tool_call_start'; id: string; tool: string; input: unknown }
  | { _tag: 'tool_call_progress'; id: string; progress: string }
  | { _tag: 'tool_call_end'; id: string; result: ToolResult }
  | { _tag: 'thinking'; text: string }
  | { _tag: 'usage'; input: number; output: number; cacheRead?: number }
  | {
      _tag: 'permission_required'
      toolCallId: string
      tool: string
      input: unknown
    }
  | { _tag: 'error'; error: AgentError }
  /** 通知前端：本轮 LLM 调用详情已持久化，应刷新调用详情面板。轻量通知，不带 payload。 */
  | { _tag: 'llm_detail' }
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
  /** estimateTokens 的校准系数（由 calibrateEstimate 按真实 usage EMA 更新，默认 1.0）。 */
  calibrationFactor: number
  compactionModel?: { provider: string; model: string }
}

export type {
  AgentConfig,
  AgentError,
  AgentEvent,
  AgentState,
  AgentStatus,
  LLMDetail,
  PendingToolCall,
  TokenBudget,
}
