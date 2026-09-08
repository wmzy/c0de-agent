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

/** 上次 agent run 的持久化状态（服务重启后检测中断/恢复用）。 */
type LastRun = {
  status: 'running' | 'completed' | 'paused'
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
  /** 上次打开时间戳（ms），用于会话列表按最近打开排序。 */
  lastOpenedAt?: number
  /** P2：会话级授权模式覆盖（'auto'/'default'），跨重启持久化。 */
  permissionMode?: 'auto' | 'default'
  /** 回收站条目首次被用户看到的时间戳（ms）。回收站保留期自此起算，而非删除时间——
   *  避免「删除后长期不开服务，重启即被静默物理清除、从未见过倒计时」的墙钟缺陷。
   *  只标记一次（touchTrashSeen 不重置），保证倒计时稳定可预期。 */
  trashSeenAt?: number
  /** 回收站条目已到期、进入物理清除宽限期的时间戳（ms）。
   *  到期先标记，宽限期（默认 7 天）内可在 UI 恢复；期满后由 purgeDeletedSessions 物理清除。 */
  purgePendingAt?: number
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
  /** 会话来源：'web'（Web UI）/ 'cli'（CLI print 模式）；null=旧数据视为 web。 */
  source: 'web' | 'cli' | null
  /** 软删除时间戳（ms）；null=未删除。 */
  deletedAt: number | null
  createdAt: number
  updatedAt: number
}

export type { LastRun, Message, MessageContent, Session, SessionMetadata }
