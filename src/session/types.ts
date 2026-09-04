import type { MessageRole } from '../shared/types/base.js'
import type { ChatMessage } from '../shared/types/llm.js'
import type { Message, MessageContent, Session, SessionMetadata } from '../shared/types/message.js'

export type { MessageRole } from '../shared/types/base.js'
// Re-export shared types so consumers can import everything from the session barrel.
export type { ChatMessage, Message, MessageContent, Session, SessionMetadata }

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

/** Input for `appendMessage` — role + content; id/timestamps auto-generated. */
type MessageInput = {
  role: MessageRole
  content: MessageContent[]
  tokenCount?: number
}

/** A hot file detected from tool-call history. */
type HotFile = {
  path: string
  content: string
  tokenCount: number
  accessCount: number
}

/** Configuration for compaction. */
type CompactionConfig = {
  /** Token budget for the recent-message keep window. Messages are retained
   *  from the newest backward until their cumulative token count exceeds this
   *  value; everything older is summarized. Drives compaction by tokens, not
   *  by a fixed message count. */
  keepRecentTokens: number
  preserveSnapshots: boolean
}

/** Result of a compaction or squash operation. */
type CompactionResult =
  | {
      compacted: true
      summary: string
      archiveId: string
      fileSnapshots: string[]
      compactedCount: number
      keptCount: number
    }
  | {
      compacted: false
      reason: 'too_few_messages' | 'nothing_to_compact'
    }

/** Configuration for squash. */
type SquashConfig = {
  keepRecent: number
  preserveFileSnapshots: boolean
  archiveOriginal: boolean
}

/** Injected summarizer — the session layer does NOT import the LLM package. */
type Summarizer = (prompt: string) => Promise<string>

/** Parsed `@[archive:<id>]` / `@[squash:<n>]` reference. */
type ArchiveRef = {
  type: 'archive' | 'squash'
  id: string
}

/** A node in the session tree. */
type SessionTreeNode = {
  session: Session
  children: SessionTreeNode[]
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

/** A decoded file snapshot row. */
type FileSnapshot = {
  id: string
  sessionId: string
  filePath: string
  content: string
  contentHash: string
  tokenCount: number
  version: number
  /** 快照创建时文件磁盘 mtime（毫秒）；旧行无此字段（迁移前写入） */
  mtimeMs?: number
  createdAt: number
}

export type {
  ArchiveRef,
  BranchSummaryEntry,
  CompactionArchive,
  CompactionConfig,
  CompactionEntry,
  CompactionResult,
  FileSnapshot,
  HotFile,
  MessageInput,
  SessionEntry,
  SessionTreeNode,
  SquashConfig,
  SquashEntry,
  SteeringEntry,
  Summarizer,
}
