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
export { editTool } from './builtin/edit.js'
export { globTool, globToRegex } from './builtin/glob.js'
export { grepTool } from './builtin/grep.js'
// ── Builtin tools ───────────────────────────────────────────
export { readTool } from './builtin/read.js'
export { writeTool } from './builtin/write.js'
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

// ── Default registry ────────────────────────────────────────
import { bashTool } from './builtin/bash.js'
import { editTool } from './builtin/edit.js'
import { globTool } from './builtin/glob.js'
import { grepTool } from './builtin/grep.js'
import { readTool } from './builtin/read.js'
import { writeTool } from './builtin/write.js'
import { createToolRegistry, registerTool } from './registry.js'

/**
 * Create a registry pre-loaded with all builtin tools:
 * read, write, edit, glob, grep, bash.
 */
export function createDefaultRegistry() {
  const reg = createToolRegistry()
  registerTool(reg, readTool)
  registerTool(reg, writeTool)
  registerTool(reg, editTool)
  registerTool(reg, globTool)
  registerTool(reg, grepTool)
  registerTool(reg, bashTool)
  return reg
}
