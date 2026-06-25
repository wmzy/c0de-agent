// Agent package public API (spec §3).
//
// Re-exports every type and function the rest of the codebase is allowed to
// depend on. New code should import from here rather than from leaf modules.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  AgentConfig,
  AgentError,
  AgentEvent,
  AgentState,
  AgentStatus,
  CompactionConfig,
  LifecycleEvent,
  LLMDetail,
  Message,
  ProjectInfo,
  Skill,
  ThinkMode,
  ThinkModeState,
  ThinkingClassification,
  TokenBudget,
} from "./types";

export { THINK_MODES } from "./types";

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

// Core agent functions
export {
  createAgent,
  runAgent,
  abortAgent,
  injectSteeringMessage,
  pauseAgent,
  resumeAgent,
  waitForResume,
  isAgentPaused,
  getAgentStatus,
} from "./run";

// Lifecycle event infrastructure
export {
  emitLifecycleEvent,
  subscribeLifecycle,
  unsubscribeLifecycle,
  clearLifecycleSubscribers,
} from "./lifecycle";
export type { LifecycleSubscriber } from "./lifecycle";

// Think-mode system
export {
  classifyThinkMode,
  detectThinkMode,
  selectModelForThinkMode,
  findThinkingModel,
  classifyThinkingContent,
  createThinkModeState,
  switchThinkMode,
  resetThinkingState,
} from "./think-mode";

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export { buildSystemPrompt, convertMessageToChatMessage, DEFAULT_SYSTEM_PROMPT } from "./prompts";
