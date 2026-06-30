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
export { readTool } from './builtin/read.js'
// ── Builtin tools ───────────────────────────────────────────
export {
  createDefaultURLRegistry,
  createFileResolver,
  createSkillResolver,
} from './builtin/resolvers.js'
export { taskTool } from './builtin/task.js'
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
import { bashTool } from './builtin/bash.js'
import { dapTools } from './builtin/dap.js'
import { editTool } from './builtin/edit.js'
import { globTool } from './builtin/glob.js'
import { grepTool } from './builtin/grep.js'
import { readTool } from './builtin/read.js'
import { taskTool } from './builtin/task.js'
import { writeTool } from './builtin/write.js'
import { yieldTool } from './builtin/yield.js'
import { createToolRegistry, registerTool } from './registry.js'
import { createWebSearchTool } from './websearch/websearch.js'

/**
 * Create a registry pre-loaded with all builtin tools:
 * read, write, edit, glob, grep, bash, task, websearch, and the debug_* set.
 *
 * @param config 可选配置；websearch 工具按 config.websearch 构造。省略时用 DEFAULT_CONFIG。
 */
export function createDefaultRegistry(config: Config = DEFAULT_CONFIG) {
  const reg = createToolRegistry()
  registerTool(reg, readTool)
  registerTool(reg, writeTool)
  registerTool(reg, editTool)
  registerTool(reg, globTool)
  registerTool(reg, grepTool)
  registerTool(reg, bashTool)
  registerTool(reg, taskTool)
  registerTool(reg, yieldTool)
  registerTool(reg, createWebSearchTool(config.websearch))
  for (const tool of dapTools) registerTool(reg, tool)
  return reg
}
