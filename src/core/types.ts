import type { DB } from '../db/client.js'
import type { Registry } from '../llm/registry.js'
import type {
  AgentConfig,
  AgentError,
  AgentEvent,
  AgentState,
  AgentStatus,
  LLMDetail,
  PendingToolCall,
  TokenBudget,
} from '../shared/types/agent.js'
import type { ChatTool } from '../shared/types/llm.js'
import type { ToolDef } from '../shared/types/tool.js'
import type { PermissionChecker, ToolRegistry } from '../tools/types.js'
import type { HookRunner } from '../plugins/types.js'
import type { Config } from './config.js'

/** Runtime services injected into every core function (DI pattern). */
type AgentDependencies = {
  db: DB
  llmRegistry: Registry
  toolRegistry: ToolRegistry
  permission: PermissionChecker
  config: Config
  cwd: string
  hookRunner?: HookRunner
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
}

type CommandResult =
  | { _tag: 'success'; message: string }
  | { _tag: 'error'; message: string }
  | { _tag: 'text'; text: string }

type CommandContext = {
  cwd: string
  config: Config
  deps: AgentDependencies
}

type SlashCommand = {
  name: string
  description: string
  argsHint?: string
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
  CommandContext,
  CommandResult,
  HookRunner,
  LLMDetail,
  PendingToolCall,
  ProjectInfo,
  PromptContext,
  SlashCommand,
  TokenBudget,
}
