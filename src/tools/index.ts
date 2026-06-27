// Tools package: tool registry, executor, validation, truncation, and builtin tools.

// ── Framework ───────────────────────────────────────────────
export {
  createToolRegistry,
  getTool,
  getToolSchemas,
  listTools,
  registerTool,
  registerToolFactory,
} from './registry.js'
export { autoAllowChecker, createPermissionChecker } from './permission.js'
export { executeTool } from './executor.js'
export { validateInput } from './validate.js'
export { DEFAULT_TRUNCATE_OPTIONS, truncateOutput } from './truncate.js'

// ── Builtin tools ───────────────────────────────────────────
export { readTool } from './builtin/read.js'
export { writeTool } from './builtin/write.js'
export { editTool } from './builtin/edit.js'
export { globToRegex, globTool } from './builtin/glob.js'
export { grepTool } from './builtin/grep.js'
export { bashTool } from './builtin/bash.js'

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

// ── Re-exports from shared ──────────────────────────────────
export type { JSONSchema } from '../shared/types/base.js'
export type {
  ChatTool,
  ToolContext,
  ToolDef,
  ToolExecutor,
  ToolMode,
  ToolPermission,
  ToolResult,
} from '../shared/types/tool.js'

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
