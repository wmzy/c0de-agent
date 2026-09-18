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
  /** 工作流运行会话对应的 /workflow 名称（创建时写入；中断恢复指引展示用）。 */
  workflowName?: string
  /** 本会话分段增量 LLM 调用记录，用于调用详情面板展示。 */
  segments?: LLMSegment[]
  /** 上次 agent run 状态；status='running' 且进程无活跃 run → 被中断。 */
  lastRun?: LastRun
  /** M3：中断 run 的半截轮次区间起点——最后一条含文本 user 消息的条目 id。
   *  区间 (since, until] 内的条目属「未完成轮次」：构建上下文时剔除、时间线置灰。
   *  与 unfinishedUntilEntryId 成对使用；条目被 /clear、压缩归档后区间自然失效（no-op）。 */
  unfinishedSinceEntryId?: string
  /** M3：中断轮次区间终点——标记时数据库中最后一条条目的 id（含）。 */
  unfinishedUntilEntryId?: string
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
  /**
   * P2-3：最近一次预算超支暂停的原因（loop 暂停时写入）。热更新/重启后 run 重建，
   * 内存 budgetPauseTriggered 标记丢失——新 run 启动时消费此字段还原标记，
   * 避免用户已确认继续后又被同一超支原因二次暂停。消费即删除（单次语义）。
   */
  budgetPauseReason?: string
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
