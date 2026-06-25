// Core public API barrel (per design spec §3.1).
//
// Re-exports every type and function the rest of the codebase is allowed to
// depend on. Internal helpers (private to each file) are not re-exported —
// import from the leaf module if you genuinely need them.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  AgentConfig,
  AgentError,
  AgentEvent,
  AgentHookMap,
  AgentState,
  AgentStatus,
  CommandContext,
  CommandResult,
  CompactionConfig,
  Config,
  JSONSchema,
  LLMDetail,
  MCPServerConfig,
  Message,
  MessageContentPart,
  ProjectInfo,
  PromptBuildContext,
  PromptContext,
  PromptRegistry,
  PromptSection,
  Skill,
  SlashCommand,
  ThinkMode,
  ThinkModeState,
  ThinkingClassification,
  TokenBudget,
  ToolContext,
  ToolDef,
  ToolPermission,
  ToolResult,
} from "./types";

export { THINK_MODES } from "./types";

// ---------------------------------------------------------------------------
// Tool metrics (§16.5)
// ---------------------------------------------------------------------------

export { getMetrics, recordToolResult, selectBestMode } from "./tool-metrics";
export type { ModelToolMetrics } from "./tool-metrics";

// ---------------------------------------------------------------------------
// Configuration (load / save / merge / resolveAgentConfig)
// ---------------------------------------------------------------------------

export {
  DEFAULT_COMPACTION,
  DEFAULT_CONFIG,
  deriveEnabledPlugins,
  deriveEnabledTools,
  globalConfigPath,
  loadConfig,
  mergeConfig,
  projectConfigPath,
  resolveAgentConfig,
  saveConfig,
} from "./config";
export type { ConfigScope } from "./config";

// ---------------------------------------------------------------------------
// Token budget + compaction
// ---------------------------------------------------------------------------

export {
  allocateBudget,
  compactIfNeeded,
  compactMessages,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  fitToBudget,
  makeTokenBudget,
  passthroughSummarizer,
  shouldCompact,
} from "./context";
export type {
  BudgetAllocation,
  CompactionState,
  Summarizer,
} from "./context";
export {
  renderMessagesToImage,
  snapCompact,
} from "./snap-compact";
export type {
  SnapCompactOptions,
  SnapCompactResult,
} from "./snap-compact";

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export {
  AGENTS_PRIORITY,
  AGENTS_SECTION_ID,
  CONSTRAINTS_PRIORITY,
  CONSTRAINTS_SECTION_ID,
  PROJECT_PRIORITY,
  PROJECT_SECTION_ID,
  ROLE_PRIORITY,
  ROLE_SECTION_ID,
  SKILLS_PRIORITY,
  SKILLS_SECTION_ID,
  SLASH_COMMANDS_PRIORITY,
  SLASH_COMMANDS_SECTION_ID,
  TOOLS_PRIORITY,
  TOOLS_SECTION_ID,
  buildSystemPrompt,
  buildSystemPromptFromRegistry,
  createPromptRegistry,
  defaultPromptRegistry,
  registerPromptSection,
  renderAgentsSection,
  renderProjectSection,
  renderSkillsSection,
  renderToolsSection,
  resolveSectionContent,
  unregisterPromptSection,
} from "./prompt";

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

export {
  BUILTIN_COMMANDS,
  executeSlashCommand,
  parseSlashCommand,
} from "./commands";

// ---------------------------------------------------------------------------
// Hot update (§18)
// ---------------------------------------------------------------------------

export {
  checkForUpdate,
  performHotUpdate,
  restoreSessionState,
  serializeSessionState,
} from "./update";
export type { SessionSnapshot, UpdateCheckResult } from "./update";

// ---------------------------------------------------------------------------
// URL scheme registry (§3.10)
// ---------------------------------------------------------------------------

export {
  createURLRegistry,
  registerBuiltInResolvers,
  registerURLResolver,
  resolveURL,
} from "./url-registry";
export type { URLRegistry, URLResolver, URLResolveContext } from "./url-registry";

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

export { validatePlan } from "./plan-validator";
export type {
  PlanDependency,
  PlanError,
  PlanRisk,
  PlanSection,
  PlanStep,
  ValidationResult,
} from "./plan-validator";

// ---------------------------------------------------------------------------
// MnemoPi memory engine (§memory)
// ---------------------------------------------------------------------------

export {
  applyDecay,
  autoAssociate,
  autoCompress,
  compressMemories,
  createAssociation,
  createMemory,
  exportMemories,
  getAssociations,
  importMemories,
  injectMemory,
  recallAndInject,
  scoreMemory,
  searchMemory,
  touchMemory,
} from "./memory";
export type { DecayConfig, MemoryAssociation, MemoryEntry, MemoryExportPayload } from "./memory";

// ---------------------------------------------------------------------------
// Skill reminder (Oh-My-OpenAgent inspired)
// ---------------------------------------------------------------------------

export {
  CATEGORIES,
  buildSkillReminders,
  detectAllCategories,
  detectCategory,
  getReminder,
} from "./skill-reminder";
export type { SkillCategory } from "./skill-reminder";

// ---------------------------------------------------------------------------
// Preemptive compaction (proactive context compression + degradation monitoring)
// ---------------------------------------------------------------------------

export {
  checkAndCompact,
  checkDegradation,
  createPreemptiveState,
  DEFAULT_PREEMPTIVE_COMPACTION,
  estimateGrowthRate,
  projectNextTurnTokens,
} from "./preemptive-compaction";
export type {
  CheckAndCompactOptions,
  CheckAndCompactResult,
  DegradationReport,
  PreemptiveCompactionConfig,
  PreemptiveCompactionState,
} from "./preemptive-compaction";

// ---------------------------------------------------------------------------
// Compaction degradation monitor (quality tracking + auto re-compact)
// ---------------------------------------------------------------------------

export {
  analyzeQualityTrend,
  computeQualityScore,
  createDegradationState,
  DEFAULT_DEGRADATION_CONFIG,
  extractSignificantTokens,
  getCompactionStats,
  monitorCompactionQuality,
  recordCompaction,
  shouldRecompact,
  triggerRecompact,
} from "./compaction-degradation-monitor";
export type {
  CompactionDegradationConfig,
  CompactionDegradationReport,
  CompactionDegradationState,
  CompactionQualitySnapshot,
  CompactionStats,
  QualityTrend,
} from "./compaction-degradation-monitor";

// ---------------------------------------------------------------------------
// Swarm multi-agent orchestration (§swarm)
// ---------------------------------------------------------------------------

export {
  assignTask,
  cancelTask,
  createSwarm,
  dispatchPending,
  getAgent,
  getAgentTasks,
  getMessages,
  getSwarmStatus,
  getTask,
  retryTask,
  sendMessage,
  updateAgentStatus,
} from "./swarm";
export type {
  SwarmAgent,
  SwarmAgentStatus,
  SwarmManager,
  SwarmMessage,
  SwarmStatus,
  SwarmTask,
  SwarmTaskHandler,
  SwarmTaskStatus,
} from "./swarm";
