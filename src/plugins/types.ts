// src/plugins/types.ts
import type { AgentConfig } from '../shared/types/agent.js'
import type { Config } from '../shared/types/config.js'
import type { ChatMessage, ChatRequest, ProviderConfig, StreamChunk } from '../shared/types/llm.js'
import type { Message, Session } from '../shared/types/message.js'
import type { ToolContext, ToolDef, ToolResult } from '../shared/types/tool.js'

// ── Logger ──────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

type Logger = {
  debug: (msg: string, ...args: unknown[]) => void
  info: (msg: string, ...args: unknown[]) => void
  warn: (msg: string, ...args: unknown[]) => void
  error: (msg: string, ...args: unknown[]) => void
}

// ── Hook system ─────────────────────────────────────────────

/** Unified event map. `domain:before` = chain (can modify/abort); `domain:after` = broadcast. */
type HookMap = {
  'agent:start': { config: AgentConfig }
  'agent:end': Record<string, never>
  'tool:before': { tool: string; input: unknown; ctx: ToolContext }
  'tool:after': { tool: string; input: unknown; result: ToolResult; ctx: ToolContext }
  'provider:before': { request: ChatRequest }
  'provider:after': { request: ChatRequest; chunks: StreamChunk[] }
  'message:before': { messages: ChatMessage[] }
  'message:after': { message: Message }
  'session:create': { session: Session }
  'session:fork': { source: Session; fork: Session }
  'session:compact': { before: number; after: number }
  'config:resolve': { config: Config }
}

/** Hook handler. Returns T (possibly modified) or false (abort). void = passthrough. */
// biome-ignore lint/suspicious/noConfusingVoidType: void is intentional for passthrough semantics
type HookHandler<T> = (data: T) => T | false | void | Promise<T | false | void>

/** Options for createHookRunner. */
type HookRunnerOptions = {
  /** Per-handler timeout in ms. Default 5000. */
  timeout?: number
  /** Logger for error/timeout warnings. Default: console. */
  logger?: Logger
}

/** Mutable event registry. Functions are context-first (runner as hidden state). */
type HookRunner = {
  on: <K extends keyof HookMap>(
    event: K,
    handler: HookHandler<HookMap[K]>,
    priority?: number,
  ) => void
  off: <K extends keyof HookMap>(event: K, handler: HookHandler<HookMap[K]>) => void
  runHooks: <K extends keyof HookMap>(event: K, data: HookMap[K]) => Promise<HookMap[K] | false>
  fireHooks: <K extends keyof HookMap>(event: K, data: HookMap[K]) => Promise<void>
  dispose: () => void
}

// ── Plugin ──────────────────────────────────────────────────

/** A process-level plugin. `setup` is called during activation; `dispose` during deactivation. */
type Plugin = {
  name: string
  version: string
  description?: string
  setup: (ctx: PluginContext) => void | Promise<void>
  dispose?: () => void | Promise<void>
}

/** Context passed to plugin.setup(). Delegates to real registries. */
type PluginContext = {
  registerTool: (tool: ToolDef) => void
  registerProvider: (provider: ProviderConfig) => void
  on: HookRunner['on']
  off: HookRunner['off']
  getConfig: () => Config
  getLogger: (name: string) => Logger
  onDispose: (handler: () => void | Promise<void>) => void
}

/** Runtime status of a loaded plugin. */
type PluginStatus = 'loaded' | 'active' | 'error' | 'inactive'

/** Internal record stored in PluginRegistry. */
type PluginRecord = {
  plugin: Plugin
  status: PluginStatus
  error?: string
  disposeHandlers: (() => void | Promise<void>)[]
}

/** Mutable plugin registry. */
type PluginRegistry = {
  plugins: Map<string, PluginRecord>
  hookRunner: HookRunner
}

/** Services needed to create PluginContext during activation. */
type PluginServices = {
  config: Config
  toolRegistry: unknown
  llmRegistry: unknown
}

export type {
  AgentConfig,
  ChatMessage,
  ChatRequest,
  Config,
  HookHandler,
  HookMap,
  HookRunner,
  HookRunnerOptions,
  Logger,
  LogLevel,
  Message,
  Plugin,
  PluginContext,
  PluginRecord,
  PluginRegistry,
  PluginServices,
  PluginStatus,
  ProviderConfig,
  Session,
  StreamChunk,
  ToolContext,
  ToolDef,
  ToolResult,
}
