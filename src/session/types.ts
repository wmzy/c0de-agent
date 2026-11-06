import type { MessageRole } from '../shared/types/base.js'
import type { ChatMessage } from '../shared/types/llm.js'
import type { Message, MessageContent, Session, SessionMetadata } from '../shared/types/message.js'
// 会话条目/视图类型已上移 shared（web 端此前手抄副本漂移）；此处 re-export 保持旧导出面不变。
import type {
  BranchSummaryEntry,
  CompactionArchive,
  CompactionEntry,
  SessionEntry,
  SessionTreeNode,
  SessionUsage,
  SquashEntry,
  SteeringEntry,
} from '../shared/types/session-view.js'

export type { MessageRole } from '../shared/types/base.js'
// Re-export shared types so consumers can import everything from the session barrel.
export type { ChatMessage, Message, MessageContent, Session, SessionMetadata }

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
  SessionUsage,
  SquashConfig,
  SquashEntry,
  SteeringEntry,
  Summarizer,
}
