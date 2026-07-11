// Core package: agent loop, prompt building, config, context management,
// steering, slash commands, and compaction bridge.

export {
  abortAgent,
  createAgent,
  getAgentStatus,
  isAgentPaused,
  pauseAgent,
  resumeAgent,
  runAgent,
} from './agent.js'
export { createSummarizer, runCompaction } from './compact.js'
export type { CompactionConfig, Config, MCPServerConfig } from './config.js'
export { DEFAULT_CONFIG, loadConfig, mergeConfig, saveConfig } from './config.js'
export {
  calibrateEstimate,
  createTokenBudget,
  estimateBudget,
  fitToBudget,
  shouldCompact,
} from './context.js'
export { agentLoop } from './loop.js'
export { buildSystemPrompt } from './prompt.js'
export type { SlashRegistry } from './slash.js'
export { builtinCommands, createSlashRegistry, parseSlashInput } from './slash.js'
export { clearSteering, drainSteering, injectSteering } from './steering.js'
export type { CollectedToolCall, ToolCallResult } from './tool-exec.js'
export { executeToolCall, executeToolCalls, partitionByConflict } from './tool-exec.js'
export type {
  AgentConfig,
  AgentDependencies,
  AgentError,
  AgentEvent,
  AgentState,
  AgentStatus,
  CommandContext,
  CommandResult,
  LLMSegment,
  PendingToolCall,
  ProjectInfo,
  PromptContext,
  SlashCommand,
  TokenBudget,
} from './types.js'
export { buildWorkflowNotice, containsWorkflow, WORKFLOW_NOTICE } from './workflow.js'
export type {
  WorkflowAgentResult,
  WorkflowContext,
  WorkflowEntry,
  WorkflowMeta,
  WorkflowRegistry,
  WorkflowResult,
  WorkflowUtils,
} from './workflows/index.js'
export {
  BUILTIN_WORKFLOWS,
  buildWorkflowContext,
  createAndPopulateRegistry,
  createBuiltinWorkflows,
  createWorkflowRegistry,
  discoverWorkflows,
  executeWorkflow,
} from './workflows/index.js'
