import type { Message, Session } from './message.js'

/** A compaction summary entry — replaces compacted messages with a summary. */
type CompactionEntry = {
  _tag: 'compaction'
  id: string
  sessionId: string
  summary: string
  originalEntryIds: string[]
  archiveId: string
  tokenCount: number
  createdAt: number
}

/** A squash entry — compresses recent interactions into a summary. */
type SquashEntry = {
  _tag: 'squash'
  id: string
  sessionId: string
  summary: string
  squashedEntryIds: string[]
  archiveId: string
  tokenCount: number
  createdAt: number
}

/** Records that a session was forked from another. */
type BranchSummaryEntry = {
  _tag: 'branch_summary'
  id: string
  sessionId: string
  summary: string
  sourceSessionId: string
  createdAt: number
}

/** A steering instruction injected mid-conversation. */
type SteeringEntry = {
  _tag: 'steering'
  id: string
  sessionId: string
  content: string
  createdAt: number
}

/** All session entries, ordered chronologically. Narrow via `'_tag' in entry`. */
type SessionEntry = Message | CompactionEntry | SquashEntry | BranchSummaryEntry | SteeringEntry

/** 会话级用量汇总（P0 审查：列表视图此前无法回答「会话花了多少 token/钱」）。
 *  从 metadata.segments 聚合，零额外查询。 */
type SessionUsage = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cost: number
  /** 价格未知（cost=null）的调用数：成本按 $0 计入，UI 需提示低估。 */
  unknownCostCalls: number
  calls: number
}

/** A node in the session tree. */
type SessionTreeNode = {
  session: Session
  children: SessionTreeNode[]
  usage: SessionUsage
}

/** A decoded compaction archive row. */
type CompactionArchive = {
  id: string
  sessionId: string
  compactionId: string
  archiveType: 'compaction' | 'squash' | 'shake' | 'clear'
  originalEntries: SessionEntry[]
  summary: string
  tokenCount: number
  searchableText: string
  createdAt: number
}

/** API 返回给前端的区域视图。 */
type ShakeRegionView = {
  id: string
  kind: 'toolResult' | 'block'
  messageId: string
  messageIndex: number
  partIndex: number
  tokens: number
  label: string
  preview: string
  placeholder: string
  isAfterProtectWindow: boolean
  /** tool_result 的 tool_call_id（仅 toolResult 类别），前端跨消息合并后匹配渲染块。 */
  toolCallId?: string
}

export type {
  BranchSummaryEntry,
  CompactionArchive,
  CompactionEntry,
  SessionEntry,
  SessionTreeNode,
  SessionUsage,
  ShakeRegionView,
  SquashEntry,
  SteeringEntry,
}
