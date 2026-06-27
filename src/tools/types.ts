import type { JSONSchema } from '../shared/types/base.js'
import type {
  ChatTool,
  ToolContext,
  ToolDef,
  ToolExecutor,
  ToolMode,
  ToolPermission,
  ToolResult,
} from '../shared/types/tool.js'

// ── Registry types ──────────────────────────────────────────

/** Mutable tool registry. Stores both eager tool definitions and lazy factories. */
type ToolRegistry = {
  tools: Map<string, ToolDef>
  factories: Map<string, ToolFactory>
}

/** Context passed to tool factories for lazy tool construction. */
type ToolFactoryContext = {
  config: Record<string, unknown>
  cwd: string
}

/** Factory function for lazy tool loading. Returns null if tool is unavailable. */
type ToolFactory = (ctx: ToolFactoryContext) => ToolDef | null

// ── Permission types ────────────────────────────────────────

/** Result of a permission check. */
type PermissionResult =
  | { _tag: 'allow' }
  | { _tag: 'deny'; reason: string }
  | { _tag: 'ask'; reason: string; toolCallId: string }

/** Permission checker interface. The executor calls `check` before running a tool. */
type PermissionChecker = {
  check: (tool: ToolDef, input: unknown, ctx: ToolContext) => Promise<PermissionResult>
  confirm: (toolCallId: string, approved: boolean) => void
}

// ── Validation types ────────────────────────────────────────

/** Result of JSON Schema validation. */
type ValidationResult = { valid: true } | { valid: false; error: string }

// ── Truncation types ────────────────────────────────────────

/** Options for output truncation. */
type TruncateOptions = {
  maxLines: number
  maxChars: number
  headLines: number
  tailLines: number
}

/** Result of output truncation. */
type TruncateResult = {
  output: string
  truncated: boolean
  totalLines: number
  totalChars: number
}

// ── Builtin tool input types ────────────────────────────────

/** Input for the read tool. */
type ReadInput = {
  path: string
  offset?: number
  limit?: number
}

/** Input for the write tool. */
type WriteInput = {
  path: string
  content: string
}

/** Input for the edit tool (search/replace diff mode). */
type EditInput = {
  path: string
  oldText: string
  newText: string
}

/** Input for the glob tool. */
type GlobInput = {
  pattern: string
  path?: string
}

/** Input for the grep tool. */
type GrepInput = {
  pattern: string
  path?: string
  caseSensitive?: boolean
  maxResults?: number
}

/** Input for the bash tool (sync mode). */
type BashInput = {
  command: string
  cwd?: string
  timeout?: number
  env?: Record<string, string>
}

/** A single grep match. */
type GrepMatch = {
  file: string
  line: number
  text: string
  match: string
}

// ── Re-exports ──────────────────────────────────────────────

export type {
  ChatTool,
  JSONSchema,
  PermissionChecker,
  PermissionResult,
  ReadInput,
  ToolContext,
  ToolDef,
  ToolExecutor,
  ToolFactory,
  ToolFactoryContext,
  ToolMode,
  ToolPermission,
  ToolRegistry,
  ToolResult,
  ValidationResult,
}
export type {
  BashInput,
  EditInput,
  GlobInput,
  GrepInput,
  GrepMatch,
  TruncateOptions,
  TruncateResult,
  WriteInput,
}
