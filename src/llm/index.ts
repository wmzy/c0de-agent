// Public API for the LLM package (§4).
//
// Canonical exports follow the design spec. The bottom of this file also
// re-exports a small set of legacy type names that pre-date §4 so external
// packages (agent/, tools/, api/) can keep compiling during the multi-step
// migration. New code should import from the canonical names at the top.

export type {
  CacheRegistry,
  CacheStrategy,
  ChatMessage,
  ChatRequest,
  ChatTool,
  ContentPart,
  FallbackChain,
  FallbackChainRuntime,
  JSONSchema,
  Model,
  ModelCapabilities,
  ModelOverride,
  ModelRole,
  ProtocolHandler,
  ProviderConfig,
  ProviderHealthState,
  ProviderInstance,
  ProviderRegistry,
  ResolvedModel,
  RetryContext,
  RetryLogEntry,
  RetryStrategy,
  RoleBinding,
  RoleRouting,
  StreamChunk,
  ToolCallWire,
} from "./types";

export {
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_ROLES,
} from "./types";

export {
  calculateCost,
  estimateContentTokens,
  estimateRequestTokens,
  estimateTokenCount,
} from "./token";

export {
  getModelCapabilities,
  listRegisteredModels,
  registerModel,
} from "./models";

export {
  aggregateStream,
  chunkDone,
  chunkError,
  chunkText,
  chunkThinking,
  chunkToolCall,
  chunkUsage,
  parseSSE,
} from "./stream";

export type { AggregatedResponse, SSEEvent } from "./stream";

export {
  addProvider,
  applyCacheOptimization,
  chatStream,
  chatStreamWithFallback,
  computeRetryDelay,
  createCacheRegistry,
  createFallbackChainRuntime,
  createHandler,
  createProviderRegistry,
  getActiveProviders,
  getProvider,
  getRetryStrategy,
  isProviderAvailable,
  markProviderCooldown,
  markProviderExhausted,
  registerCacheStrategy,
  resolveModel,
  resolveRoleBinding,
  setRoleRouting,
} from "./provider";

export { createOpenAIHandler } from "./protocol/openai";
export { createOpenAICompatHandler } from "./protocol/openai-compat";
export { createAnthropicHandler } from "./protocol/anthropic";
export {
  compressMessages,
  createRecoveryState,
  recordRecoveryAttempt,
  truncateMessages,
  adjustMaxTokens,
  TRUNCATION_STRATEGIES,
  DEFAULT_TRUNCATION_STRATEGY,
} from "./context-recovery";
export type {
  ContextRecoveryState,
  ContextTruncationStrategy,
  TruncationStrategyName,
  RecoveryLogEntry,
  RecoveryStats,
} from "./context-recovery";
export { createGoogleHandler } from "./protocol/google";

export type {
  ErrorClassification,
  ErrorEvent,
  ErrorEventType,
  ErrorHistory,
  ErrorReport,
  ErrorStats,
  ErrorTrend,
  ErrorTrendWindow,
  LearnedPattern,
  PatternMatchInfo,
  ReportEntry,
} from "./errors";

export {
  analyzeTrends,
  classifyError,
  classifyQuotaSubType,
  createErrorHistory,
  extractRetryAfterMs,
  generateErrorReport,
  getErrorStats,
  getLearnedPatterns,
  getPatternMatches,
  isAuthError,
  isContentFilter,
  isContextOverflow,
  isModelNotFound,
  isNetworkError,
  isOverloaded,
  isQuotaExceeded,
  isQuotaTemporary,
  isRateLimited,
  isRequestTooLarge,
  isServerError,
  isToolError,
  learnPattern,
  pruneHistory,
  recordError,
  removeLearnedPattern,
  shouldAbortForSubAgent,
  shouldRetry,
} from "./errors";

// ---------------------------------------------------------------------------
// Legacy re-exports
//
// These names pre-date §4 and are referenced by agent/, tools/, api/ which
// have not yet been migrated to the new spec. Shapes live in types-compat
// (kept structurally identical to the previous file) and are re-exported
// here so consumers continue to type-check. New code MUST use the canonical
// names above; once the rest of the codebase migrates, delete types-compat
// and this block.
// ---------------------------------------------------------------------------

export type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionUsage,
  LegacyProviderConfig,
  LLMProvider,
  Message,
  ToolCall,
  ToolDefinition,
} from "./types-compat";

export { createProvider } from "./legacy-shim";
