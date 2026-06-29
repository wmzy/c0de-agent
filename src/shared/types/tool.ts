import type { JSONSchema, SessionRef } from './base.js'

/** Permission level for tool execution. */
type ToolPermission = 'auto' | 'ask' | 'deny'

/** Result of a tool execution. Discriminated by `_tag`. */
type ToolResult =
  | { _tag: 'success'; output: string; metadata?: Record<string, unknown> }
  | { _tag: 'error'; error: string }
  | { _tag: 'permission_required'; reason: string }
  | { _tag: 'truncated'; output: string; truncated: boolean; totalLines: number }

/** Context passed to a URL resolver (skill://, agent://, pr://, …). */
type URLResolveContext = {
  cwd: string
  session: SessionRef
}

/** A resolver for one URL scheme (e.g. `skill`, `agent`, `pr`). */
type URLResolver = {
  scheme: string
  resolve: (url: string, ctx: URLResolveContext) => Promise<string>
}

/** Mutable registry of URL resolvers, keyed by scheme. */
type URLRegistry = {
  resolvers: Map<string, URLResolver>
}

/** Result of resolving a URL. */
type ResolveResult = { _tag: 'ok'; content: string } | { _tag: 'error'; error: string }

/** Transport shape for a debug adapter process stdio (DAP). Host-injected. */
type DebugTransport = {
  write: (chunk: string | Uint8Array) => void
  onData: (handler: (chunk: Uint8Array | string) => void) => void
  onClose: (handler: () => void) => void
  close: () => void
}

/** Context passed to every tool executor. */
type ToolContext = {
  cwd: string
  session: SessionRef
  abort: AbortSignal
  mode?: string
  /** URL resolver registry; present when the host wires up internal URL schemes. */
  urlRegistry?: URLRegistry
  /** Spawn a sub-agent and return its final text output (dependency-reversal hook
   *  for the `task` tool; avoids tools→core circular import). */
  runSubAgent?: (input: SubAgentRequest) => Promise<SubAgentResult>
  /** Spawn a debug adapter and return its stdio transport (dependency-reversal
   *  hook for the `debug_*` tools; host wires real child_process spawn). */
  debugSpawn?: (config: unknown) => DebugTransport
}

/** Request to run a sub-agent (the `task` tool's payload to the host). */
type SubAgentRequest = {
  prompt: string
  description?: string
  model?: string
}

/** Result of a sub-agent run. */
type SubAgentResult =
  | { _tag: 'success'; output: string; sessionId: string }
  | { _tag: 'error'; error: string }

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

export type {
  DebugTransport,
  ResolveResult,
  SubAgentRequest,
  SubAgentResult,
  ToolContext,
  ToolDef,
  ToolExecutor,
  ToolMode,
  ToolPermission,
  ToolResult,
  URLRegistry,
  URLResolveContext,
  URLResolver,
}
