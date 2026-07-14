import type { JSONSchema, SessionRef } from './base.js'

// Forward-declared type for the todo state hook. The full TodoPhase type lives
// in tools/builtin/todo.ts; here we only need the structural shape for the hook.
type TodoPhaseLike = { name: string; tasks: { content: string; status: string }[] }

/** Permission level for tool execution. */
type ToolPermission = 'auto' | 'ask' | 'deny'

/** Result of a tool execution. Discriminated by `_tag`. */
type ToolResult =
  | { _tag: 'success'; output: string; metadata?: Record<string, unknown>; shakenAt?: number }
  | { _tag: 'error'; error: string; shakenAt?: number }
  | { _tag: 'permission_required'; reason: string }
  | { _tag: 'truncated'; output: string; truncated: boolean; totalLines: number; shakenAt?: number }

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
  /** 子 agent 专用：yield 工具调用时收集结构化结果（runSubAgent 注入）。 */
  collectYield?: (data: unknown) => void
  /** Todo state accessor (dependency-reversal for the `todo` tool).
   *  Host (agent loop) injects get/set backed by AgentState.todoPhases. */
  todoState?: {
    get: () => TodoPhaseLike[]
    set: (phases: TodoPhaseLike[]) => void
  }
}

/** 单个并行子任务项（批量模式）。 */
type TaskItem = {
  description?: string
  /** 角色细分（注入子 prompt）。 */
  role?: string
  assignment: string
}

/** Request to run a sub-agent (the `task` tool's payload to the host). */
type SubAgentRequest = {
  /** agent 类型名（必填）。 */
  agentType: string
  prompt: string
  description?: string
  /** 批量模式的角色细分。 */
  role?: string
  /** 批量模式的共享上下文。 */
  context?: string
  model?: string
  /** 后台异步运行（默认 false）。 */
  background?: boolean
}

/** Result of a sub-agent run. */
type SubAgentResult =
  | { _tag: 'success'; output: string; sessionId: string; data?: unknown; patchPath?: string }
  | { _tag: 'error'; error: string; sessionId?: string }
  | { _tag: 'running'; jobId: string; sessionId: string }

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

/** Per-(model, tool, mode) success/latency record used to auto-select the
 *  best tool mode (spec §16.5). Persisted in the `tool_metrics` table. */
type ModelToolMetrics = {
  model: string
  tool: string
  mode: string
  attempts: number
  successes: number
  failures: number
  avgLatencyMs: number
  lastUsed: number
}

export type {
  DebugTransport,
  ModelToolMetrics,
  ResolveResult,
  SubAgentRequest,
  SubAgentResult,
  TaskItem,
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
