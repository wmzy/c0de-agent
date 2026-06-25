// Tools package public API (spec §5).
//
// Re-exports every type and function the rest of the codebase is allowed to
// depend on. Internal helpers (private to each file) are not re-exported —
// import from the leaf module if you genuinely need them.
//
// createDefaultRegistry() creates a ToolRegistry pre-populated with all
// built-in tools: bash, read, write, edit, glob, grep, ast_grep, ast_edit,
// task, web_search.

import type { ToolRegistry } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  SessionRef,
  ToolContext,
  ToolDef,
  ToolExecutor,
  ToolPermission,
  ToolRegistry,
  ToolResult,
} from "./types";

// Shared tool-result constructors
export { ok, err, permissionRequired, truncated } from "./types";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

import { createToolRegistry, registerTool } from "./registry";
export { createToolRegistry, getTool, listTools, registerTool } from "./registry";

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export { executeTool, truncateOutput, truncateResult, createPermissionChecker } from "./executor";
export type {
  ExecuteToolOptions,
  PermissionChecker,
  PermissionCheckerConfig,
  PermissionCheckResult,
  TruncateOptions,
  TruncateOutput,
} from "./executor";
export { DEFAULT_TRUNCATE_OPTIONS } from "./executor";

// ---------------------------------------------------------------------------
// Revert mechanism
// ---------------------------------------------------------------------------
export {
  createRevertStore,
  createSessionRevertStore,
  isRevertable,
  extractFilePaths,
  withRevertProtection,
} from "./revert";
export type { FileSnapshot, RevertLogEntry, RevertStore, SessionRevertStore, SnapshotBatch, TrackedFile } from "./revert";

// ---------------------------------------------------------------------------
// JSON recovery
// ---------------------------------------------------------------------------
export {
  detectJsonErrors,
  tryFixJson,
  recoverToolInput,
  recoverJsonOrThrow,
  formatRecoverySummary,
  DEFAULT_FIXERS,
} from "./json-recovery";
export type {
  JsonDetection,
  JsonErrorDetail,
  JsonErrorKind,
  JsonRecoveryFixer,
  JsonRecoveryResult,
  JsonOk,
} from "./json-recovery";

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

import { astEditTool } from "./ast_edit";
import { astGrepTool } from "./ast_grep";
import { bashTool } from "./bash";
import { browserTool } from "./browser";
import {
  debugBreakpointTool,
  debugContinueTool,
  debugEvalTool,
  debugStackTool,
  debugStartTool,
  debugStepTool,
  debugStopTool,
  debugVarsTool,
} from "./dap";
import { editTool } from "./edit";
import { readTool, writeTool } from "./file";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { lspTool } from "./lsp";
import { taskTool } from "./task";
import { webSearchTool } from "./websearch";
import { worktreeTool } from "./worktree";
export { bashTool } from "./bash";
export { checkFsync } from "./fsync-guard";
export type { FsyncGuardResult } from "./fsync-guard";
export { checkBashFileRead, extractBashReadPaths, formatBashFileReadMessage } from "./bash-file-read-guard";
export type { BashFileReadGuardResult } from "./bash-file-read-guard";
export { readTool, writeTool } from "./file";
export { editTool } from "./edit";
export { globTool } from "./glob";
export { grepTool } from "./grep";
export { astGrepTool } from "./ast_grep";
export { astEditTool } from "./ast_edit";
export { taskTool } from "./task";
export { webSearchTool } from "./websearch";
export { lspTool } from "./lsp";
export { worktreeTool } from "./worktree";
export { browserTool } from "./browser";
export {
  debugStartTool,
  debugBreakpointTool,
  debugContinueTool,
  debugStepTool,
  debugStackTool,
  debugVarsTool,
  debugEvalTool,
  debugStopTool,
} from "./dap";

// ---------------------------------------------------------------------------
// Tool-pair validator (spec §tool-pair)
// ---------------------------------------------------------------------------

export {
  createPairValidatorState,
  recordToolCall,
  validateToolCall,
  validateToolCalls,
  getViolations,
  getHistory,
  formatViolations,
  hasCriticalViolation,
} from "./tool-pair-validator";
export type {
  PairValidatorState,
  PairViolation,
  ToolCallRecord,
  Severity,
} from "./tool-pair-validator";

// ---------------------------------------------------------------------------
// Edit-specific exports (hashline utilities, spec §16)
// ---------------------------------------------------------------------------

export { computeHash, parsePatch, applyPatch } from "./edit";
export type { ParsedPatch, ApplyResult } from "./edit";

// ---------------------------------------------------------------------------
// Hashline edit diff enhancer
// ---------------------------------------------------------------------------

export {
  generateDiff,
  formatDiff,
  formatDiffSummary,
  formatInlineDiff,
  detectSyntaxBlocks,
  findBlockByName,
  findBlockAtLine,
  generateEnhancedPatch,
  toHashlineFormat,
} from "./hashline-edit-diff-enhancer";
export type {
  SyntaxBlock,
  SyntaxBlockKind,
  DiffResult,
  DiffHunk,
  DiffLine,
  DiffLineKind,
  DiffConfig,
  EnhancedPatch,
  EnhancedPatchOp,
} from "./hashline-edit-diff-enhancer";

// ---------------------------------------------------------------------------
// Hashline read enhancer (spec §16)
// ---------------------------------------------------------------------------

export {
  detectHashlineFormat,
  parseHashReference,
  applyHashlinePatches,
  readWithHashline,
} from "./hashline-read-enhancer";
export type {
  HashlineDetection,
  HashReference,
  HashlineReadResult,
  HashlineReadOptions,
} from "./hashline-read-enhancer";

// ---------------------------------------------------------------------------
// AST edit type exports
// ---------------------------------------------------------------------------

export type { ASTEditOp, ASTEditPreview } from "./ast_edit";

// ---------------------------------------------------------------------------
// Output truncator (smart, semantic-aware truncation)
// ---------------------------------------------------------------------------

export {
  truncateOutput as smartTruncate,
  truncateToolResult as smartTruncateResult,
  truncateOutputForTool,
  resolveToolStrategy,
  createDefaultToolRegistry,
  generateTruncationSummary,
  computeTruncationStats,
  emitTruncationLog,
  classifyLine,
  classifyLines,
  truncateSemantic,
  truncateByLine,
  truncateByChar,
  truncateSmart,
  bashStrategy,
  grepStrategy,
  testStrategy,
  DEFAULT_TRUNCATOR_CONFIG,
} from "./output-truncator";
export type {
  LineImportance,
  ScoredLine,
  TruncationStrategy,
  SemanticStrategy,
  LineStrategy as OutputLineStrategy,
  CharStrategy as OutputCharStrategy,
  SmartStrategy,
  TruncatedOutput,
  OutputTruncatorConfig,
  TruncationStats,
  TruncationSummary,
  TruncationLogEntry,
  ToolStrategyOverride,
  ToolStrategyRegistry,
} from "./output-truncator";

// ---------------------------------------------------------------------------
// Output analyzer (semantic analysis of tool output)
// ---------------------------------------------------------------------------

export {
  analyzeToolOutput,
  detectOutputFormat,
  detectErrors,
  extractKeyInfo,
  generateSummary,
  hasErrors,
  hasWarnings,
  getMostSevereError,
  formatAnalysisResult,
} from "./output-analyzer";
export type {
  ErrorSeverity,
  ErrorPattern,
  Suggestion,
  ExtractedInfo,
  OutputFormat,
  AnalysisSummary,
  AnalysisResult,
} from "./output-analyzer";

// ---------------------------------------------------------------------------
// createDefaultRegistry — create a registry with all built-in tools
// ---------------------------------------------------------------------------

export function createDefaultRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registerTool(registry, bashTool);
  registerTool(registry, readTool);
  registerTool(registry, writeTool);
  registerTool(registry, editTool);
  registerTool(registry, globTool);
  registerTool(registry, grepTool);
  registerTool(registry, astGrepTool);
  registerTool(registry, astEditTool);
  registerTool(registry, taskTool);
  registerTool(registry, webSearchTool);
  registerTool(registry, lspTool);
  registerTool(registry, worktreeTool);
  registerTool(registry, browserTool);
  registerTool(registry, debugStartTool);
  registerTool(registry, debugBreakpointTool);
  registerTool(registry, debugContinueTool);
  registerTool(registry, debugStepTool);
  registerTool(registry, debugStackTool);
  registerTool(registry, debugVarsTool);
  registerTool(registry, debugEvalTool);
  registerTool(registry, debugStopTool);
  return registry;
}
