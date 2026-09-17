import type { DB } from '../db/client.js'
import type { chat as ChatFn } from '../llm/provider.js'
import type { Registry } from '../llm/registry.js'
import type { HookRunner } from '../plugins/types.js'
import type {
  AgentConfig,
  AgentError,
  AgentEvent,
  AgentState,
  AgentStatus,
  LLMSegment,
  PendingToolCall,
  TokenBudget,
} from '../shared/types/agent.js'
import type { ChatTool } from '../shared/types/llm.js'
import type { DebugTransport, ToolDef, URLRegistry } from '../shared/types/tool.js'
import type { PermissionChecker, ToolRegistry } from '../tools/types.js'
import type { AgentRegistry } from './agents/types.js'
import type { Config } from './config.js'

/** Runtime services injected into every core function (DI pattern). */

/** 子 agent run 句柄：注册到宿主 run 跟踪器所需的最小信息。
 *  deps 为子 agent 的 LoopDeps（cwd=隔离 worktree/父 cwd、深度注入等），
 *  宿主据此执行 pause/resume/abort（与主 run 同口径）。 */
type ChildRunHandle = {
  sessionId: string
  /** 父会话 id——树级联（删除父中止全部后代、权限超时暂停主 run + 子 run）的依据。 */
  parentSessionId?: string
  /** 后台任务 jobId（= 子会话 id，仅 background 模式）。 */
  jobId?: string
  state: AgentState
  deps: AgentDependencies
}

/** 注册子 agent run 到宿主 run 跟踪器；返回注销函数（幂等）。 */
type RegisterChildRun = (run: ChildRunHandle) => () => void

type AgentDependencies = {
  db: DB
  llmRegistry: Registry
  toolRegistry: ToolRegistry
  permission: PermissionChecker
  config: Config
  cwd: string
  hookRunner?: HookRunner
  /** Optional URL resolver registry wired into tool contexts (spec §3.10). */
  urlRegistry?: URLRegistry
  /** Optional prompt registry for dynamic system-prompt assembly (spec §17).
   *  When provided, the agent loop renders the prompt from it; otherwise the
   *  default built-in registry is used. Plugins register sections here. */
  promptRegistry?: PromptRegistry
  /** 可注入的标题生成 chat 实现（测试用）；省略走真实 llm/provider。 */
  titleChatFn?: typeof ChatFn
  /** 可选调试适配器 spawn 钩子（spec §21）：注入后 debug_* 工具可用。
   *  接收 debug_start 的配置，返回适配器进程的 stdio transport。 */
  debugSpawn?: (config: unknown) => DebugTransport
  /** Agent 类型注册表（spec: multi-agent-design）。注入后 task 工具可按类型派发。 */
  agentRegistry?: AgentRegistry
  /** 子 agent run 注册回调（P1：此前子 run 从未入宿主 run 跟踪器，暂停/热更新/
   *  删除会话/权限超时级联全部绕过同步与后台子 agent）。宿主注入实现：
   *  Web = agentManager.register/unregister；CLI 无 run 跟踪器，不注入即 no-op。
   *  返回注销函数（幂等），子 agent run 终止时（finally）调用。 */
  registerChildRun?: RegisterChildRun
}

type ProjectInfo = {
  name: string
  language: string
  framework?: string
  rootDir: string
  gitBranch?: string
}

type PromptContext = {
  tools: ToolDef[]
  config: AgentConfig
  projectInfo: ProjectInfo
  skills?: string[]
  cwd?: string
}

/** Build context for dynamic prompt assembly (spec §17). */
type PromptBuildContext = {
  tools: ToolDef[]
  config: AgentConfig
  projectInfo: ProjectInfo
  skills?: string[]
  agents?: string[]
  cwd?: string
}

/** A dynamically composable system-prompt section (spec §17). */
type PromptSection = {
  id: string
  title?: string
  /** Static body. Overridden by `render` when present. */
  content: string
  /** Lower priority sorts earlier. */
  priority: number
  /** Omit the section when false. */
  condition?: (ctx: PromptBuildContext) => boolean
  /** Dynamic body; takes precedence over `content`. */
  render?: (ctx: PromptBuildContext) => string
}

/** Mutable registry of prompt sections, keyed by id (later registration wins). */
type PromptRegistry = {
  sections: Map<string, PromptSection>
}

type CommandResult =
  | { _tag: 'success'; message: string }
  | { _tag: 'error'; message: string }
  | { _tag: 'text'; text: string }
  | { _tag: 'compact' }

type CommandContext = {
  cwd: string
  config: Config
  deps: AgentDependencies
  /** 当前会话 id（Web chat 路由注入）：/clear /fork 等命令默认作用于当前会话。 */
  sessionId?: string
  workflowRegistry?: import('./workflows/registry.js').WorkflowRegistry
  /** 消费渠道（P3）：/model 等命令按渠道给可操作指引（CLI 无底部模型选择器）。 */
  channel?: 'web' | 'cli'
}

/** Declarative subcommand definition for commands like /workflow. */
type SubcommandDef = {
  name: string
  description: string
  /** Usage hint shown in popover, e.g. "<name> [args]". */
  usage?: string
}

type SlashCommand = {
  name: string
  description: string
  argsHint?: string
  /** Subcommands for dropdown completion (e.g. /workflow list, /workflow run). */
  subcommands?: SubcommandDef[]
  execute: (args: string, ctx: CommandContext) => Promise<CommandResult>
}

export type {
  AgentConfig,
  AgentDependencies,
  AgentError,
  AgentEvent,
  AgentState,
  AgentStatus,
  ChatTool,
  ChildRunHandle,
  CommandContext,
  CommandResult,
  HookRunner,
  LLMSegment,
  PendingToolCall,
  ProjectInfo,
  PromptBuildContext,
  PromptContext,
  PromptRegistry,
  PromptSection,
  RegisterChildRun,
  SlashCommand,
  SubcommandDef,
  TokenBudget,
}
