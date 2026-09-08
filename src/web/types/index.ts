import type { AgentEvent, LLMCall, LLMSegment, SegmentTrigger } from '@shared/types/agent.js'
import type { Config } from '@shared/types/config.js'
import type { Message, Session } from '@shared/types/message.js'
import type { ToolResult } from '@shared/types/tool.js'

export type {
  AgentEvent,
  Config,
  LLMCall,
  LLMSegment,
  Message,
  SegmentTrigger,
  Session,
  ToolResult,
}

/** 会话级用量汇总（列表展示；后端 getTree 从 metadata.segments 聚合）。 */
type SessionUsage = {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cost: number
  calls: number
}

/** 会话树节点（后端 GET /api/sessions/tree 返回）。 */
type SessionTreeNode = {
  session: Session
  children: SessionTreeNode[]
  usage: SessionUsage
}

/** 项目（GET /api/projects 返回，含实时 git 分支与 worktree 状态）。 */
type Project = {
  id: string
  worktree: string
  vcs: 'git' | null
  name: string | null
  gitRemote: string | null
  gitBranch: string | null
  /** 工作目录已失效（被删除/移动），后端实时检测。 */
  worktreeMissing?: boolean
  createdAt: number
  updatedAt: number
}

/** API 统一错误。 */
type APIError = {
  status: number
  message: string
  code?: string
  details?: Record<string, unknown>
}

/** 文件目录项（GET /api/files 返回）。 */
type FileEntry = {
  name: string
  type: 'file' | 'directory'
  ignored?: boolean
}

/** git 状态分类（GET /api/files/git-status 返回值的 value）。 */
type GitStatusCode = 'modified' | 'staged' | 'untracked' | 'conflict' | 'deleted' | 'ignored'

/** git 状态映射：path → 状态分类（GET /api/files/git-status 返回）。 */
type GitStatusMap = Record<string, GitStatusCode>

/** 文件搜索结果。 */
type FileSearchResult = {
  path: string
  type: 'file' | 'directory'
}

/** 文件读取响应。 */
type FileContent = {
  path: string
  content: string
}

/** 工具列表项（GET /api/tools 返回，不含 execute）。 */
type ToolListItem = {
  name: string
  description: string
  parameters: unknown
  permission: unknown
}

/** 代码引用（spec §10.4）。 */
type CodeReference =
  | { _tag: 'file'; path: string; startLine: number; endLine: number }
  | { _tag: 'message'; messageId: string; blockIndex: number }

/** 一键提交响应：提交成功或需要审查（检测到可疑文件）。 */
type CommitResponse =
  | { committed: true; message: string; hash: string; fileCount: number }
  | { needsReview: true; message: string; suggestions: string[] }

/** shake 区域视图（POST /sessions/:id/shake/preview 返回）。 */
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
  /** tool_result 的 tool_call_id（仅 toolResult 类别），跨消息合并后匹配渲染块。 */
  toolCallId?: string
}

/** 归档条目（原始消息/压缩摘要/转向等，与后端 SessionEntry 同构）。 */
type ArchiveEntry =
  | { _tag: 'compaction' | 'squash' | 'branch_summary'; summary: string }
  | { _tag: 'steering'; content: string }
  | {
      role: string
      content: Array<{
        _tag: string
        text?: string
        tool?: string
        input?: unknown
        output?: unknown
      }>
    }

/** 会话归档行（GET /sessions/:id/archives 返回）。 */
type CompactionArchive = {
  id: string
  sessionId: string
  archiveType: 'compaction' | 'squash' | 'shake' | 'clear'
  originalEntries: ArchiveEntry[]
  summary: string
  tokenCount: number
  createdAt: number
}

/** 会话导出（GET /sessions/:id/export 返回）。 */
type SessionExport = {
  version: 1
  exportedAt: string
  session: Session
  messages: Message[]
  archives: CompactionArchive[]
}

export type {
  APIError,
  ArchiveEntry,
  CodeReference,
  CommitResponse,
  CompactionArchive,
  FileContent,
  FileEntry,
  FileSearchResult,
  GitStatusCode,
  GitStatusMap,
  Project,
  SessionExport,
  SessionTreeNode,
  SessionUsage,
  ShakeRegionView,
  ToolListItem,
}
