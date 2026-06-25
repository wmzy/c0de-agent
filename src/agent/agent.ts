// Agent module — re-export barrel.
//
// All exports are now defined in their respective modules:
//   lifecycle.ts     — subscriber registry + emit + clear
//   think-mode.ts    — classifyThinkMode, detectThinkMode, model selection, state
//   write-conflict.ts — partitionByWriteConflict
//   anti-pattern.ts  — anti-pattern detection
//   run.ts           — createAgent, runAgent, abortAgent, pause/resume, helpers
//
// This barrel exists to preserve backward compatibility for imports
// that still reference "./agent" directly (e.g. agent.test.ts).

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type { LifecycleSubscriber } from "./lifecycle";
export {
  subscribeLifecycle,
  unsubscribeLifecycle,
  emitLifecycleEvent,
  clearLifecycleSubscribers,
} from "./lifecycle";

// ---------------------------------------------------------------------------
// Think-mode
// ---------------------------------------------------------------------------

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
// Core agent functions
// ---------------------------------------------------------------------------

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
