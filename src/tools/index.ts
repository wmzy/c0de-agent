// Tools package: tool registry, executor, validation, truncation, and builtin tools.

// ── Re-exports from shared ──────────────────────────────────
export type { JSONSchema } from '../shared/types/base.js'
export type { ChatTool } from '../shared/types/llm.js'
export type {
  ToolContext,
  ToolDef,
  ToolExecutor,
  ToolMode,
  ToolPermission,
  ToolResult,
} from '../shared/types/tool.js'
export { bashTool } from './builtin/bash.js'
export { dapTools } from './builtin/dap.js'
export { editTool } from './builtin/edit.js'
export { globTool, globToRegex } from './builtin/glob.js'
export { grepTool } from './builtin/grep.js'
export { kanbanTool } from './builtin/kanban.js'
export { readTool } from './builtin/read.js'
// ── Builtin tools ───────────────────────────────────────────
export {
  createDefaultURLRegistry,
  createFileResolver,
  createSkillResolver,
} from './builtin/resolvers.js'
export type { TodoInput, TodoItem, TodoPhase, TodoStatus } from './builtin/todo.js'
export { todoTool } from './builtin/todo.js'
export { writeTool } from './builtin/write.js'
export { yieldTool } from './builtin/yield.js'
export { executeTool } from './executor.js'
export { autoAllowChecker, createPermissionChecker } from './permission.js'
// ── Framework ───────────────────────────────────────────────
export {
  createToolRegistry,
  getTool,
  getToolSchemas,
  listTools,
  registerTool,
  registerToolFactory,
} from './registry.js'
export { DEFAULT_TRUNCATE_OPTIONS, truncateOutput } from './truncate.js'
// ── Types ───────────────────────────────────────────────────
export type {
  BashInput,
  EditInput,
  GlobInput,
  GrepInput,
  GrepMatch,
  PermissionChecker,
  PermissionResult,
  ReadInput,
  ToolFactory,
  ToolFactoryContext,
  ToolRegistry,
  TruncateOptions,
  TruncateResult,
  ValidationResult,
  WriteInput,
} from './types.js'
export { validateInput } from './validate.js'
// ── Websearch ───────────────────────────────────────────────
export { formatForLLM, resolveProvider, runWebSearch } from './websearch/index.js'
export type {
  WebSearchProvider,
  WebSearchProviderId,
  WebSearchResponse,
  WebSearchSource,
} from './websearch/types.js'
export { createWebSearchTool } from './websearch/websearch.js'

// ── Default registry ────────────────────────────────────────
import { DEFAULT_CONFIG } from '../core/config.js'
import type { Config } from '../shared/types/config.js'
import type { ToolDef } from '../shared/types/tool.js'
import { bashTool } from './builtin/bash.js'
import { dapTools } from './builtin/dap.js'
import { editTool } from './builtin/edit.js'
import { globTool } from './builtin/glob.js'
import { grepTool } from './builtin/grep.js'
import { kanbanTool } from './builtin/kanban.js'
import { readTool } from './builtin/read.js'
import { taskTool } from './builtin/task.js'
import { todoTool } from './builtin/todo.js'
import { writeTool } from './builtin/write.js'
import { yieldTool } from './builtin/yield.js'
import { createToolRegistry, listTools, registerTool } from './registry.js'
import type { ToolRegistry } from './types.js'
import { createWebSearchTool } from './websearch/websearch.js'

/**
 * Create a registry pre-loaded with all builtin tools:
 * read, write, edit, glob, grep, bash, task, websearch, and the debug_* set.
 *
 * config.tools.disabled 中的工具**不注册**——registry 层过滤保证两个入口
 * （CLI print / Web chat / /api/tools 列表）统一生效，禁用的工具对 agent 完全不可见。
 * @param config 可选配置；websearch 工具按 config.websearch 构造。省略时用 DEFAULT_CONFIG。
 */
export function createDefaultRegistry(config: Config = DEFAULT_CONFIG) {
  const reg = createToolRegistry()
  const disabled = new Set(config.tools?.disabled ?? [])
  const register = (tool: ToolDef): void => {
    if (!disabled.has(tool.name)) registerTool(reg, tool)
  }
  register(readTool)
  register(writeTool)
  register(editTool)
  register(globTool)
  register(grepTool)
  register(bashTool)
  register(kanbanTool)
  register(taskTool)
  register(todoTool)
  register(yieldTool)
  register(createWebSearchTool(config.websearch))
  for (const tool of dapTools) register(tool)
  return reg
}

/**
 * 解析本轮启用的工具名列表（P1-1 修复：config.tools.enabled/disabled 双入口统一生效）。
 *
 * - explicit（前端显式选择）非 undefined → 以其为准，但过滤掉 disabled 与未注册名。
 * - 否则 enabled 非空 → enabled ∩ registered；enabled 空 → 全部 registered（空=全部）。
 * - disabled 恒过滤（registry 已排除，此处兜底）。
 */
export function resolveEnabledToolNames(
  registry: ToolRegistry,
  config: Pick<Config, 'tools'>,
  explicit?: string[],
): string[] {
  const all = listTools(registry).map((t) => t.name)
  const disabled = new Set(config.tools?.disabled ?? [])
  const base =
    explicit ??
    (config.tools?.enabled && config.tools.enabled.length > 0 ? config.tools.enabled : all)
  return base.filter((n) => all.includes(n) && !disabled.has(n))
}
