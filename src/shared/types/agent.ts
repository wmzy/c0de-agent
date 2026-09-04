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
  | { _tag: 'interrupted' }

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
  /** P1-6：权限确认超时（5 分钟）被自动拒绝时通知前端，提供「重新询问」入口。 */
  | { _tag: 'permission_timeout'; toolCallId: string; tool: string; input: unknown }
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
  /**
   * 会话压缩成功后发出（spec: plugin-hooks `session:compact`）。
   * 实际发生压缩（runCompaction 返回 compacted=true）时才 yield；
   * nothing_to_compact 不发。archiveId/summary 仅在真实压缩时存在。
   */
  | {
      _tag: 'compaction_done'
      summary: string
      archiveId?: string
      compactedCount: number
      keptCount: number
    }
  /** Tag-based todo 操作成功后发射，前端据此刷新 TodoPanel。 */
  | {
      _tag: 'todo_update'
      phases: { name: string; tasks: { content: string; status: string }[] }[]
    }
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
  /** 分阶段任务列表（todo 工具状态）。in-memory，通过 tool result metadata 持久化。
   *  createAgent 时从历史消息恢复；每次 todo 工具调用通过 todoState hook 更新。 */
  todoPhases: { name: string; tasks: { content: string; status: string }[] }[]
  compactionModel?: { provider: string; model: string }
  /**
   * 压缩死锁标记：自动压缩成功后仍超阈值（如 keepRecentTokens 本身已超限）时置真，
   * 暂停后续自动压缩以防每轮重复触发（无限循环）。收到新用户消息（agentLoop 重入）时重置。
   */
  compactionDeadEnd?: boolean
  /**
   * 压缩退化监测器：压缩成功后初始化，监测接下来若干轮 assistant 回复。
   * 若连续产生空回复（无实质文本且无 tool_call），发出非致命警告（不中断循环），
   * 提示 agent 可能在"沉默退化"。remaining 耗尽即清除；新一轮用户输入
   * （agentLoop 重入）时不会自动重置——它由压缩成功单独建立。
   */
  postCompactionMonitor?: { remaining: number; noTextStreak: number }
  /** 本次 run 开始时间戳（ms）。暂停持久化 lastRun 时回填 startedAt。 */
  lastRunStartedAt?: number
  /** 暂停状态是否已 yield 给前端（loop 内用，防重复 status_change）。 */
  pauseYielded?: boolean
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
