import type { AgentEvent, LLMDetail } from '@shared/types/agent.js'
import type { Config } from '@shared/types/config.js'
import type { Message, Session } from '@shared/types/message.js'
import type { ToolResult } from '@shared/types/tool.js'

export type { AgentEvent, Config, LLMDetail, Message, Session, ToolResult }

/** 会话树节点（后端 GET /api/sessions/tree 返回）。 */
type SessionTreeNode = {
  session: Session
  children: SessionTreeNode[]
}

/** 项目（GET /api/projects 返回，含实时 git 分支）。 */
type Project = {
  id: string
  worktree: string
  vcs: 'git' | null
  name: string | null
  gitRemote: string | null
  gitBranch: string | null
  createdAt: number
  updatedAt: number
}

/** API 统一错误。 */
type APIError = {
  status: number
  message: string
  code?: string
}

/** 文件目录项（GET /api/files 返回）。 */
type FileEntry = {
  name: string
  type: 'file' | 'directory'
}

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

export type {
  APIError,
  CodeReference,
  FileContent,
  FileEntry,
  FileSearchResult,
  Project,
  SessionTreeNode,
  ToolListItem,
}
