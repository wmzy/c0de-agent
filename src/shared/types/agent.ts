import type { ChatTool } from './llm.js'
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
  /** primary agent 名（段记录用，spec: agent-frontend-switching §4.2）。 */
  agentName?: string
  /** primary agent 的 role prompt（仅覆盖 role section，保留动态上下文）。 */
  agentRolePrompt?: string
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

/** 段内单次 LLM 调用的轻量记录（不含 messages/systemPrompt/tools——那些是段级或派生数据）。 */
type LLMCall = {
  id: string
  timestamp: number
  usage: { input: number; output: number; cacheRead?: number }
  latency: { firstToken: number; total: number }
  cost: number
  thinking?: string
  /** 模型回复文本（替代完整 responseChunks；前端只用文本拼接）。 */
  responseText: string
  /** 非正常停止原因（length/content_filter），正常完成为 undefined。 */
  finishReason?: string
}

/** 触发新段的原因。 */
type SegmentTrigger =
  | 'initial'
  | 'model_change'
  | 'tools_change'
  | 'system_prompt_change'
  | 'compaction'
  | 'user_confirmed'

/**
 * 一段共享相同前缀（systemPrompt + tools + provider + model）的连续 LLM 调用。
 * 段首存一次前缀快照，段内 calls 只记轻量增量，消除每轮重复存储完整 messages 的 O(N²) 冗余。
 */
type LLMSegment = {
  id: string
  /** hash(systemPrompt + 规格化 tools)。变化 = 前缀失效 = cache miss。 */
  fingerprint: string
  provider: string
  model: string
  /** 段首快照：本段生命周期内恒定的系统提示词。 */
  systemPrompt: string
  /** 段首快照：本段启用的工具规格。 */
  tools: ChatTool[]
  startedAt: number
  trigger: SegmentTrigger
  /** 段首 primary agent 名（段检测比较用，spec: agent-frontend-switching §4.3）。 */
  agentName?: string
  /** 模型上下文窗口（来自 registry capabilities），用于总结面板使用率。段内恒定。 */
  contextWindow?: number
  calls: LLMCall[]
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
  | {
      _tag: 'subagent_start'
      childId: string
      agentType: string
      description: string
      background: boolean
    }
  | {
      _tag: 'subagent_progress'
      childId: string
      toolName?: string
      status: 'running' | 'completed' | 'failed'
    }
  | { _tag: 'subagent_end'; childId: string; agentType: string; success: boolean; output?: string }
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
  segments: LLMSegment[]
  /** compaction 等事件要求下一轮强制开新段时设置；loop 消费后清除。 */
  pendingSegmentTrigger?: SegmentTrigger
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
  LLMCall,
  LLMSegment,
  PendingToolCall,
  SegmentTrigger,
  TokenBudget,
}
