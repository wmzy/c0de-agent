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
import type { Message } from '../shared/types/message.js'
import type { DebugTransport, ToolDef, URLRegistry } from '../shared/types/tool.js'
import type { PermissionChecker, ToolRegistry } from '../tools/types.js'
import type { AgentRegistry } from './agents/types.js'
import type { Config } from './config.js'
import type { ContextFileBundle } from './context-files.js'

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
  /** 跨会话项目决策记忆（sharpshooter）的上下文加载器。宿主（chat/print
   *  组装点）在 memory backend 激活时注入；agent loop 每轮调用并把返回文本
   *  作为 memory 分片注入系统提示。返回 null/空串时该分片不出现。 */
  loadMemoryContext?: (cwd: string) => Promise<string | null>
  /** TTSR 流规则检查器（regex 子集）：每个流式 text delta 调用，命中返回
   *  注入文本；agent loop 收到命中后丢弃本轮输出、注入规则并从同点重试。
   *  由宿主在存在激活规则文件（.c0de/rules/*.md 或全局 ~/.c0de/rules/*.md）
   *  时注入。 */
  streamRuleChecker?: StreamRuleChecker
  /** send 工具的投递通道：向运行中 agent（含子 agent run）注入 steering
   *  消息。web 侧桥接 agentManager.steer（runs 表含子 run，P1 已注册）；
   *  省略时 send 工具不可用。 */
  steerAgent?: (sessionId: string, message: string) => { delivered: boolean; detail: string }
  /** Advisor 影子审查运行时：每个 tool round 结束后 fire-and-forget 触发
   *  （不阻塞主循环）；note 经实现自带的注入回调（通常桥 injectSteering）
   *  在下一 turn 边界合入。实现见 advisor 模块。 */
  advisorRuntime?: AdvisorRuntime
}

/** TTSR 流规则命中信息：injection 为渲染好的完整注入文本。 */
type StreamRuleMatch = { ruleName: string; injection: string }

/** 流规则检查器（结构类型；实现见 stream-rules 模块）。resetStream 在
 *  本轮被丢弃/正常结束后调用，重置跨 delta 的匹配缓冲。 */
type StreamRuleChecker = {
  checkTextDelta: (delta: string) => StreamRuleMatch | null
  resetStream: () => void
}

/** Advisor 影子审查运行时（结构类型；实现见 advisor 模块）。messages 为该
 *  会话全量 DB 消息——实现内部按 seen 前缀 diff 出本 turn 增量。 */
type AdvisorRuntime = {
  onTurnEnd: (input: {
    sessionId: string
    cwd: string
    messages: Message[]
    willContinue: boolean
  }) => void
  dispose?: () => void
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
  /** Project prompt overrides (`<cwd>/.c0de/prompts/*.md`) load only when the
   *  project is trusted — prompt text propagates via git clone and steers the
   *  model, so it is gated with the same fail-closed rule as project
   *  plugins/workflows. Resolved by the agent loop (needs db + fingerprint). */
  projectTrusted?: boolean
  /** 仓库上下文文件（AGENTS.md/CLAUDE.md/.cursor rules 等，恒注入）。由 agent
   *  loop 每轮发现（子 agent 已剔除 AGENTS.md/CLAUDE.md 层级文件）。 */
  contextFiles?: ContextFileBundle
  /** 跨会话项目决策记忆（sharpshooter），backend 预渲染的文本块。由宿主
   *  （chat/print 组装点）经 deps.loadMemoryContext 加载后注入；子 agent
   *  同样注入（项目决策对子 agent 一样成立）。 */
  memoryContext?: string
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
  AdvisorRuntime,
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
  ContextFileBundle,
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
  StreamRuleChecker,
  StreamRuleMatch,
  SubcommandDef,
  TokenBudget,
}
