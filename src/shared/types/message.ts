import type { LLMDetail } from './agent.js'
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

/** Session metadata for branching and compaction tracking. */
type SessionMetadata = {
  mainThreadId?: string
  squashCount?: number
  fileSnapshots?: string[]
  /** 本会话历次 LLM 调用详情，用于调用详情面板展示。 */
  llmDetails?: LLMDetail[]
}

/** A conversation session (may have a parent for branching). */
type Session = {
  id: string
  title: string
  parentId: string | null
  projectId: string | null
  branchPoint: number | null
  metadata: SessionMetadata
  createdAt: number
  updatedAt: number
}

export type { Message, MessageContent, Session, SessionMetadata }
