// Preemptive compaction — compress context BEFORE hitting the hard threshold.
//
// The reactive `compactIfNeeded` in context.ts triggers only when
// usage/total > threshold, which can cause sudden context loss or a burst
// of compaction work mid-turn.  Preemptive compaction monitors the *rate*
// of token growth and fires earlier when the projected next-turn usage
// would breach the threshold.
//
// Design:
//   - data + functions only (no class, no this, no enum)
//   - pure data types for config and state, mutating only through explicit
//     state parameters (same pattern as CompactionState in context.ts)
//   - degradation monitoring tracks successive compactions to warn when
//     compaction frequency suggests the context window is too small or
//     the conversation is growing too fast for stable operation.

import type { CompactionConfig, Message, TokenBudget } from "./types";
import {
  compactMessages,
  estimateMessageTokens,
  estimateMessagesTokens,
  shouldCompact,
} from "./context";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Controls preemptive-compaction behavior.
 *
 * `triggerThreshold` must be lower than `CompactionConfig.threshold` to
 * fire before the reactive path.  The default (0.7) triggers when
 * projected usage hits 70 % of total tokens, giving a comfortable
 * margin before the hard 80 % threshold.
 */
export type PreemptiveCompactionConfig = {
  /** Whether preemptive compaction is enabled. */
  enabled: boolean;
  /**
   * Projected usage ratio (0–1) at which to fire preemptive compaction.
   * MUST be < CompactionConfig.threshold to avoid racing the reactive path.
   */
  triggerThreshold: number;
  /** Number of recent turns used to compute the token growth rate. */
  growthRateWindow: number;
  /**
   * Number of consecutive compactions before a degradation warning is
   * emitted.  Set to 0 to disable degradation monitoring.
   */
  maxCompactionsBeforeWarning: number;
};

export const DEFAULT_PREEMPTIVE_COMPACTION: PreemptiveCompactionConfig = {
  enabled: true,
  triggerThreshold: 0.7,
  growthRateWindow: 3,
  maxCompactionsBeforeWarning: 5,
};

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

/**
 * Mutable tracking state for preemptive compaction.
 *
 * Callers MUST persist this across turns (same object reference).  The
 * `checkAndCompact` function mutates it in-place.
 */
export type PreemptiveCompactionState = {
  /** Rolling window of per-turn token estimates (newest last). */
  tokenHistory: number[];
  /** Total number of compactions triggered (preemptive + reactive). */
  compactionCount: number;
  /** Number of agent turns observed since tracking started. */
  turnCount: number;
  /** Token estimate immediately after the most recent compaction. */
  tokensAfterLastCompaction: number;
  /**
   * Rolling record of (turnIndex, compactionCount) snapshots.
   * Used to compute the compaction-per-turn ratio for degradation.
   */
  degradationSnapshots: Array<{ turn: number; compactions: number }>;
};

/** Create a fresh tracking state. */
export function createPreemptiveState(): PreemptiveCompactionState {
  return {
    tokenHistory: [],
    compactionCount: 0,
    turnCount: 0,
    tokensAfterLastCompaction: 0,
    degradationSnapshots: [],
  };
}

// ---------------------------------------------------------------------------
// Degradation result
// ---------------------------------------------------------------------------

/**
 * Returned alongside every `checkAndCompact` call so the caller can
 * surface degradation warnings to the user or agent event stream.
 */
export type DegradationReport = {
  /** Whether the degradation threshold has been breached. */
  degraded: boolean;
  /** Compactions per turn over the observed window. */
  compactionRate: number;
  /** Human-readable explanation when `degraded` is true. */
  reason: string | null;
};

// ---------------------------------------------------------------------------
// Growth-rate prediction
// ---------------------------------------------------------------------------

/**
 * Estimate the average per-turn token growth from the recent history
 * window.  Returns 0 when fewer than 2 data points exist.
 */
export function estimateGrowthRate(state: PreemptiveCompactionState, window: number): number {
  const slice = state.tokenHistory.slice(-window);
  if (slice.length < 2) return 0;
  // Linear slope: (last - first) / (n - 1)
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  return (last - first) / (slice.length - 1);
}

/**
 * Project the token usage for the *next* turn based on the current
 * estimate plus the observed growth rate.
 */
export function projectNextTurnTokens(
  currentTokens: number,
  growthRate: number,
): number {
  return Math.max(0, Math.floor(currentTokens + growthRate));
}

// ---------------------------------------------------------------------------
// Degradation monitoring
// ---------------------------------------------------------------------------

/**
 * Evaluate whether compaction frequency indicates degradation.
 *
 * Degradation = compactions are firing so often that the agent is losing
 * context faster than it can be usefully consumed.  This typically means
 * the context window is too small for the task or the conversation should
 * be forked / restarted.
 */
export function checkDegradation(
  state: PreemptiveCompactionState,
  config: PreemptiveCompactionConfig,
): DegradationReport {
  if (config.maxCompactionsBeforeWarning <= 0) {
    return { degraded: false, compactionRate: 0, reason: null };
  }

  // Compute compaction rate from the most recent window of snapshots.
  const snapshots = state.degradationSnapshots;
  if (snapshots.length < 2) {
    return { degraded: false, compactionRate: 0, reason: null };
  }

  const recent = snapshots[snapshots.length - 1]!;
  const older = snapshots[Math.max(0, snapshots.length - config.growthRateWindow)]!;
  const turnDelta = recent.turn - older.turn;
  const compactionDelta = recent.compactions - older.compactions;

  if (turnDelta <= 0) {
    return { degraded: false, compactionRate: 0, reason: null };
  }

  const rate = compactionDelta / turnDelta;
  const degraded =
    state.compactionCount >= config.maxCompactionsBeforeWarning && rate > 0.5;

  return {
    degraded,
    compactionRate: rate,
    reason: degraded
      ? `Compaction rate ${rate.toFixed(2)} compactions/turn exceeds threshold; ${state.compactionCount} compactions in ${state.turnCount} turns. Consider increasing context window or forking the session.`
      : null,
  };
}

// ---------------------------------------------------------------------------
// checkAndCompact — main entry point
// ---------------------------------------------------------------------------

/**
 * Options passed into `checkAndCompact`.  This is a plain data bag so
 * callers can assemble it from their existing agent state without
 * coupling to any particular module.
 */
export type CheckAndCompactOptions = {
  /** Current conversation messages (mutated in-place on compaction). */
  messages: Message[];
  /** Token budget for the current model. */
  tokenBudget: TokenBudget;
  /** Standard compaction config (threshold, keepRecent, etc.). */
  compactionConfig: CompactionConfig;
  /** Preemptive compaction config. */
  preemptiveConfig: PreemptiveCompactionConfig;
  /** Preemptive tracking state (persists across calls). */
  preemptiveState: PreemptiveCompactionState;
  /** Optional custom summarizer; defaults to the local fallback. */
  summarizer?: (messages: Message[], config: CompactionConfig) => Promise<string>;
};

/**
 * Result of a `checkAndCompact` invocation.
 */
export type CheckAndCompactResult = {
  /** `true` if messages were compacted (preemptive OR reactive). */
  compacted: boolean;
  /** Which strategy fired, if any. */
  strategy: "preemptive" | "reactive" | "none";
  /** Current token estimate after any compaction. */
  currentTokens: number;
  /** Projected next-turn tokens (only meaningful when not compacted). */
  projectedTokens: number;
  /** Degradation report. */
  degradation: DegradationReport;
};

/**
 * Analyse token usage, project future growth, and compact proactively
 * when the projected usage would breach the hard threshold.
 *
 * The function also falls back to reactive compaction (via `shouldCompact`
 * from context.ts) if the preemptive check was not triggered but usage
 * already exceeds the hard threshold.
 *
 * Call this once per agent turn, after the LLM response has been appended
 * to `messages`.
 *
 * @returns `CheckAndCompactResult` with compaction outcome and degradation info.
 */
export async function checkAndCompact(
  opts: CheckAndCompactOptions,
): Promise<CheckAndCompactResult> {
  const {
    messages,
    tokenBudget,
    compactionConfig,
    preemptiveConfig,
    preemptiveState,
    summarizer,
  } = opts;

  // --- Bookkeeping: record this turn ---------------------------------
  preemptiveState.turnCount += 1;
  const currentTokens = estimateMessagesTokens(messages);
  preemptiveState.tokenHistory.push(currentTokens);

  // Trim the token history to a reasonable max to avoid unbounded growth.
  const maxHistory = Math.max(preemptiveConfig.growthRateWindow * 4, 20);
  while (preemptiveState.tokenHistory.length > maxHistory) {
    preemptiveState.tokenHistory.shift();
  }

  // --- Project next-turn usage ---------------------------------------
  const growthRate = estimateGrowthRate(
    preemptiveState,
    preemptiveConfig.growthRateWindow,
  );
  const projectedTokens = projectNextTurnTokens(currentTokens, growthRate);

  // --- Preemptive check: would next turn exceed the hard threshold? --
  let compacted = false;
  let strategy: "preemptive" | "reactive" | "none" = "none";

  if (
    preemptiveConfig.enabled &&
    compactionConfig.enabled &&
    tokenBudget.total > 0
  ) {
    const projectedRatio = projectedTokens / tokenBudget.total;
    const hasDroppable =
      messages.filter((m) => m.role !== "system").length > tokenBudget.keepRecent;

    if (projectedRatio >= preemptiveConfig.triggerThreshold && hasDroppable) {
      // Fire preemptive compaction using the standard compaction pipeline.
      try {
        const result = await compactMessages(messages, compactionConfig, summarizer);
        messages.length = 0;
        messages.push(...result);
        tokenBudget.used = estimateMessagesTokens(messages);
        preemptiveState.compactionCount += 1;
        preemptiveState.tokensAfterLastCompaction = tokenBudget.used;
        compacted = true;
        strategy = "preemptive";
      } catch {
        // Preemptive compaction failure is non-fatal; fall through to
        // the reactive check which will try again if needed.
      }
    }
  }

  // --- Reactive fallback: if preemptive didn't fire but we're over ----
  if (!compacted && shouldCompact(messages, tokenBudget, compactionConfig)) {
    try {
      const result = await compactMessages(messages, compactionConfig, summarizer);
      messages.length = 0;
      messages.push(...result);
      tokenBudget.used = estimateMessagesTokens(messages);
      preemptiveState.compactionCount += 1;
      preemptiveState.tokensAfterLastCompaction = tokenBudget.used;
      compacted = true;
      strategy = "reactive";
    } catch {
      // Reactive compaction failure is non-fatal.  The agent loop will
      // continue with the original messages and can surface the error.
    }
  }

  // --- Degradation snapshot ------------------------------------------
  preemptiveState.degradationSnapshots.push({
    turn: preemptiveState.turnCount,
    compactions: preemptiveState.compactionCount,
  });
  // Keep snapshots bounded.
  while (preemptiveState.degradationSnapshots.length > maxHistory) {
    preemptiveState.degradationSnapshots.shift();
  }

  const degradation = checkDegradation(preemptiveState, preemptiveConfig);

  // --- Re-estimate after possible compaction --------------------------
  const finalTokens = compacted
    ? estimateMessagesTokens(messages)
    : currentTokens;

  return {
    compacted,
    strategy,
    currentTokens: finalTokens,
    projectedTokens: compacted
      ? projectNextTurnTokens(finalTokens, growthRate)
      : projectedTokens,
    degradation,
  };
}
