import type { LLMSegment } from './agent.js'
import type { MessageRole } from './base.js'
import type { ToolResult } from './tool.js'

/** Content variants within a single message. Discriminated by `_tag`. */
type MessageContent =
  | { _tag: 'text'; text: string }
  | { _tag: 'tool_call'; id: string; tool: string; input: unknown }
  | { _tag: 'tool_result'; id: string; tool: string; output: ToolResult }
  | { _tag: 'thinking'; text: string }
  | { _tag: 'steering'; text: string }
  | { _tag: 'image'; mediaType: string; data: string }

/** A single message in a session. Content is always an array of parts. */
type Message = {
  id: string
  sessionId: string
  role: MessageRole
  content: MessageContent[]
  tokenCount: number
  createdAt: number
}

/** 上次 agent run 的持久化状态（服务重启后检测中断用）。 */
type LastRun = {
  status: 'running' | 'completed'
  agentName?: string
  provider?: string
  model?: string
  startedAt: number
}

/** Session metadata for branching and compaction tracking. */
type SessionMetadata = {
  mainThreadId?: string
  squashCount?: number
  fileSnapshots?: string[]
  /** 本会话分段增量 LLM 调用记录，用于调用详情面板展示。 */
  segments?: LLMSegment[]
  /** 上次 agent run 状态；status='running' 且进程无活跃 run → 被中断。 */
  lastRun?: LastRun
}

/** A conversation session (may have a parent for branching). */
type Session = {
  id: string
  title: string
  parentId: string | null
  projectId: string | null
  branchPoint: number | null
  metadata: SessionMetadata
  /** 子 session 用的 agent 类型名（null=主 session）。 */
  agentType: string | null
  /** 隔离 worktree 路径（null=共享父 cwd）。 */
  worktreePath: string | null
  createdAt: number
  updatedAt: number
}

export type { LastRun, Message, MessageContent, Session, SessionMetadata }
