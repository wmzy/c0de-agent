import type { JSONSchema, SessionRef } from './base.js'

/** Permission level for tool execution. */
type ToolPermission = 'auto' | 'ask' | 'deny'

/** Result of a tool execution. Discriminated by `_tag`. */
type ToolResult =
  | { _tag: 'success'; output: string; metadata?: Record<string, unknown> }
  | { _tag: 'error'; error: string }
  | { _tag: 'permission_required'; reason: string }
  | { _tag: 'truncated'; output: string; truncated: boolean; totalLines: number }

/** Context passed to every tool executor. */
type ToolContext = {
  cwd: string
  session: SessionRef
  abort: AbortSignal
  mode?: string
}

/** Function signature for tool execution. */
type ToolExecutor = (input: unknown, ctx: ToolContext) => Promise<ToolResult>

/** Optional execution mode for tools with multiple implementations. */
type ToolMode = {
  name: string
  description: string
  isAvailable: (ctx: ToolContext) => boolean
}

/** Complete tool definition registered with the tool registry. */
type ToolDef = {
  name: string
  description: string
  parameters: JSONSchema
  permission: ToolPermission
  execute: ToolExecutor
  timeout?: number
  modes?: ToolMode[]
}

export type { ToolContext, ToolDef, ToolExecutor, ToolMode, ToolPermission, ToolResult }
