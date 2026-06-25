// Compaction degradation monitor — tracks compaction *quality* over time
// and detects when successive summaries are losing critical information.
//
// The existing preemptive-compaction.ts tracks compaction *frequency*
// (how often compactions fire).  This module complements it by measuring
// *quality* — whether the summary faithfully preserves the salient content
// of the original messages (entities, file paths, code identifiers, decisions,
// numerical values, etc.).
//
// When quality drops below a configurable threshold the monitor can
// auto-trigger a re-compaction with a wider keep-recent window, giving the
// summarizer more context to produce a better summary.
//
// Design:
//   - data + functions only (no class, no this, no enum)
//   - pure data types for config, state, and reports
//   - state is mutated in-place by explicit record/monitor calls
//   - all significant-token extraction is pattern-based (injectable)

import type { CompactionConfig, Message } from "./types";
import { compactMessages, estimateMessageTokens } from "./context";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Controls compaction quality monitoring.
 */
export type CompactionDegradationConfig = {
  /** Whether quality monitoring is enabled. */
  enabled: boolean;
  /**
   * Minimum acceptable quality score (0–1).  When the most recent
   * compaction scores below this, degradation is flagged.
   */
  qualityThreshold: number;
  /**
   * Number of recent snapshots used for the moving-average and trend
   * computation.
   */
  windowSize: number;
  /**
   * Whether to automatically trigger re-compaction when degradation is
   * detected.  The re-compaction uses a wider keep-recent window to give
   * the summarizer more material.
   */
  recompactEnabled: boolean;
  /**
   * Additional `keepRecentTokens` added to the compaction config when a
   * re-compaction is triggered.  E.g. value 2000 means the re-compaction
   * keeps 2000 more tokens of recent context than the original.
   */
  recompactKeepBonus: number;
  /**
   * Maximum number of re-compactions allowed per session.  Prevents an
   * infinite loop of compact → recompact → compact when the summarizer
   * is fundamentally inadequate.
   */
  maxRecompactions: number;
};

export const DEFAULT_DEGRADATION_CONFIG: CompactionDegradationConfig = {
  enabled: true,
  qualityThreshold: 0.5,
  windowSize: 5,
  recompactEnabled: true,
  recompactKeepBonus: 1000,
  maxRecompactions: 3,
};

// ---------------------------------------------------------------------------
// Significant-token extraction
// ---------------------------------------------------------------------------

/**
 * Default patterns that identify "significant" tokens in a message —
 * entities that a faithful summary should preserve.
 *
 * Patterns are matched case-sensitively against the raw text content.
 */
const DEFAULT_SIGNIFICANT_PATTERNS: RegExp[] = [
  // File paths  (e.g. src/core/types.ts, /usr/bin/node)
  /(?:^|[\s`"'(])(\/?[\w.-]+(?:\/[\w.-]+)+\.[\w]+)(?=[\s`"')\],;.!?:]|$)/gm,
  // camelCase / PascalCase identifiers (e.g. compactMessages, TokenBudget)
  /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g,
  // snake_case identifiers (e.g. my_function, MAX_RETRIES)
  /\b[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+\b/g,
  // Numeric values with units or context (e.g. 0.8, 2000, 100_000)
  /\b\d[\d_]*(?:\.\d+)?(?:\s*(?:%|tokens?|chars?|msgs?|turns?|ms|sec|min))\b/gi,
  // Quoted strings (e.g. "error", 'timeout')
  /["']([^"']{3,60})["']/g,
  // URL-like strings
  /https?:\/\/[^\s<>")\]]+/g,
];

/**
 * Extract significant tokens from a text string.
 *
 * Returns a deduplicated Set of matched tokens, lowercased for
 * case-insensitive comparison.
 */
export function extractSignificantTokens(
  text: string,
  patterns: RegExp[] = DEFAULT_SIGNIFICANT_PATTERNS,
): Set<string> {
  const tokens = new Set<string>();
  for (const pattern of patterns) {
    // Reset lastIndex for global regexes to ensure consistent behavior.
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      // Use the first capture group if present, otherwise the full match.
      const token = (match[1] ?? match[0]).trim().toLowerCase();
      if (token.length >= 2) {
        tokens.add(token);
      }
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Quality scoring
// ---------------------------------------------------------------------------

/**
 * Compute a quality score (0–1) measuring how well a summary preserves
 * the significant content of the original messages.
 *
 * The score is a weighted combination of:
 *   - Significant-token retention (weight 0.7): fraction of significant
 *     tokens from the originals that appear in the summary.
 *   - Compression ratio health (weight 0.3): penalizes both over-compression
 *     (summary too short → information likely lost) and under-compression
 *     (summary barely shorter → poor compaction).
 *
 * @param originalTexts - full text of the messages that were compacted
 * @param summaryText   - text of the summary message
 * @param patterns      - optional custom significant-token patterns
 */
export function computeQualityScore(
  originalTexts: string[],
  summaryText: string,
  patterns?: RegExp[],
): number {
  if (originalTexts.length === 0 || summaryText.length === 0) return 0;

  // --- Significant-token retention ---
  const originalTokens = new Set<string>();
  for (const text of originalTexts) {
    for (const tok of extractSignificantTokens(text, patterns)) {
      originalTokens.add(tok);
    }
  }

  if (originalTokens.size === 0) {
    // No significant tokens found → can't measure retention; rely on
    // compression ratio alone.
    const originalLen = originalTexts.reduce((s, t) => s + t.length, 0);
    return compressionHealth(originalLen, summaryText.length);
  }

  const summaryTokens = extractSignificantTokens(summaryText, patterns);
  let retained = 0;
  for (const tok of originalTokens) {
    if (summaryTokens.has(tok)) retained++;
  }
  const retention = retained / originalTokens.size;

  // --- Compression ratio health ---
  const originalLen = originalTexts.reduce((s, t) => s + t.length, 0);
  const health = compressionHealth(originalLen, summaryText.length);

  return 0.7 * retention + 0.3 * health;
}

/**
 * Score the compression ratio.  Ideal compression is 10–50% of original
 * length.  Returns 1.0 at the sweet spot, declining toward 0 for extreme
 * ratios.
 */
function compressionHealth(originalLen: number, summaryLen: number): number {
  if (originalLen <= 0) return 1;
  const ratio = summaryLen / originalLen;
  // Ideal ratio: 0.1 – 0.5.  Score is a triangular function peaking at 0.3.
  if (ratio <= 0) return 0;
  if (ratio <= 0.3) return ratio / 0.3;
  if (ratio <= 0.5) return 1;
  if (ratio <= 1.0) return 1 - (ratio - 0.5) / 0.5;
  return 0;
}

// ---------------------------------------------------------------------------
// Quality snapshot
// ---------------------------------------------------------------------------

/** A single quality measurement recorded after a compaction event. */
export type CompactionQualitySnapshot = {
  /** Agent turn number when the compaction occurred. */
  turn: number;
  /** Quality score (0–1). */
  qualityScore: number;
  /** Total token count of the original (pre-compaction) messages. */
  originalTokens: number;
  /** Token count of the resulting summary message. */
  summaryTokens: number;
  /** summaryTokens / originalTokens. */
  compressionRatio: number;
  /** Fraction of significant tokens retained in the summary. */
  significantTokenRetention: number;
};

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

/**
 * Mutable tracking state for compaction quality monitoring.
 *
 * Callers MUST persist this across turns (same object reference).
 */
export type CompactionDegradationState = {
  /** Ordered quality snapshots (oldest first). */
  snapshots: CompactionQualitySnapshot[];
  /** Total number of re-compactions triggered so far. */
  recompactionCount: number;
  /** Total number of compactions observed (including re-compactions). */
  totalCompactions: number;
  /** Running average quality score across all snapshots. */
  averageQuality: number;
};

/** Create a fresh degradation tracking state. */
export function createDegradationState(): CompactionDegradationState {
  return {
    snapshots: [],
    recompactionCount: 0,
    totalCompactions: 0,
    averageQuality: 1,
  };
}

// ---------------------------------------------------------------------------
// Trend analysis
// ---------------------------------------------------------------------------

/** Direction of quality trend. */
export type QualityTrend = "improving" | "stable" | "declining";

/**
 * Analyse the quality trend from recent snapshots.
 *
 * Uses a simple linear regression slope over the last `windowSize`
 * snapshots.  Returns "improving" if slope > 0.02, "declining" if
 * slope < −0.02, otherwise "stable".
 */
export function analyzeQualityTrend(
  snapshots: CompactionQualitySnapshot[],
  windowSize: number,
): QualityTrend {
  const window = snapshots.slice(-windowSize);
  if (window.length < 2) return "stable";

  // Simple linear regression: y = a + b*x
  const n = window.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = window[i]!.qualityScore;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return "stable";
  const slope = (n * sumXY - sumX * sumY) / denom;

  if (slope > 0.02) return "improving";
  if (slope < -0.02) return "declining";
  return "stable";
}

// ---------------------------------------------------------------------------
// Degradation report
// ---------------------------------------------------------------------------

/**
 * Result of a `monitorCompactionQuality` call.
 */
export type CompactionDegradationReport = {
  /** Whether quality degradation has been detected. */
  degraded: boolean;
  /** Quality score of the most recent compaction (0–1). */
  currentQuality: number;
  /** Moving-average quality over the configured window. */
  averageQuality: number;
  /** Quality trend direction. */
  trend: QualityTrend;
  /** Whether a re-compaction was triggered. */
  recompactTriggered: boolean;
  /** Human-readable explanation when `degraded` is true. */
  reason: string | null;
};

// ---------------------------------------------------------------------------
// recordCompaction — add a quality snapshot after a compaction event
// ---------------------------------------------------------------------------

/**
 * Record a compaction event.  Computes quality metrics and appends a
 * snapshot to the state.  Must be called after each compaction.
 *
 * @param state        - mutable degradation tracking state
 * @param turn         - current agent turn number
 * @param originalTexts - full text of the messages that were compacted
 * @param summaryText  - text of the summary produced by the summarizer
 * @param patterns     - optional custom significant-token patterns
 */
export function recordCompaction(
  state: CompactionDegradationState,
  turn: number,
  originalTexts: string[],
  summaryText: string,
  patterns?: RegExp[],
): void {
  const qualityScore = computeQualityScore(originalTexts, summaryText, patterns);
  const originalTokens = originalTexts.reduce(
    (sum, t) => sum + Math.ceil(t.length / 4),
    0,
  );
  const summaryTokens = Math.ceil(summaryText.length / 4);

  // Compute raw significant-token retention for the snapshot.
  const originalSigTokens = new Set<string>();
  for (const text of originalTexts) {
    for (const tok of extractSignificantTokens(text, patterns)) {
      originalSigTokens.add(tok);
    }
  }
  const summarySigTokens = extractSignificantTokens(summaryText, patterns);
  let retained = 0;
  for (const tok of originalSigTokens) {
    if (summarySigTokens.has(tok)) retained++;
  }
  const significantTokenRetention =
    originalSigTokens.size > 0 ? retained / originalSigTokens.size : 1;

  const snapshot: CompactionQualitySnapshot = {
    turn,
    qualityScore,
    originalTokens,
    summaryTokens,
    compressionRatio: originalTokens > 0 ? summaryTokens / originalTokens : 0,
    significantTokenRetention,
  };

  state.snapshots.push(snapshot);
  state.totalCompactions += 1;

  // Update running average (incremental mean).
  state.averageQuality =
    state.averageQuality + (qualityScore - state.averageQuality) / state.totalCompactions;
}

// ---------------------------------------------------------------------------
// shouldRecompact — decide whether to auto-trigger re-compaction
// ---------------------------------------------------------------------------

/**
 * Determine whether a re-compaction should be triggered based on the
 * current degradation state.
 */
export function shouldRecompact(
  state: CompactionDegradationState,
  config: CompactionDegradationConfig,
): boolean {
  if (!config.enabled || !config.recompactEnabled) return false;
  if (state.recompactionCount >= config.maxRecompactions) return false;
  if (state.snapshots.length === 0) return false;

  const latest = state.snapshots[state.snapshots.length - 1]!;
  return latest.qualityScore < config.qualityThreshold;
}

// ---------------------------------------------------------------------------
// triggerRecompact — auto re-compact with wider keep-recent window
// ---------------------------------------------------------------------------

/**
 * Trigger a re-compaction with a wider keep-recent window.
 *
 * This function:
 *   1. Increases `keepRecentTokens` by `recompactKeepBonus` in a copy
 *      of the compaction config.
 *   2. Re-runs compaction on the current messages (including the existing
 *      summary, which is treated as part of the message stream).
 *   3. Records the new quality snapshot.
 *
 * @returns the new messages array, or the original if re-compaction fails.
 */
export async function triggerRecompact(
  messages: Message[],
  state: CompactionDegradationState,
  config: CompactionDegradationConfig,
  compactionConfig: CompactionConfig,
  turn: number,
  summarizer?: (messages: Message[], config: CompactionConfig) => Promise<string>,
): Promise<Message[]> {
  // Create a relaxed compaction config with more keep-recent context.
  const relaxedConfig: CompactionConfig = {
    ...compactionConfig,
    keepRecentTokens: compactionConfig.keepRecentTokens + config.recompactKeepBonus,
  };

  try {
    const result = await compactMessages(messages, relaxedConfig, summarizer);

    // Extract texts for quality measurement.
    const originalTexts = messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
    const summaryText =
      result.length > 0
        ? typeof result[0]!.content === "string"
          ? (result[0]!.content as string)
          : JSON.stringify(result[0]!.content)
        : "";

    // Record quality for the re-compaction.
    if (summaryText.length > 0) {
      recordCompaction(state, turn, originalTexts, summaryText);
    }

    state.recompactionCount += 1;
    return result;
  } catch {
    // Re-compaction failure is non-fatal; return original messages unchanged.
    return messages;
  }
}

// ---------------------------------------------------------------------------
// monitorCompactionQuality — main entry point
// ---------------------------------------------------------------------------

/**
 * Analyse the most recent compaction's quality, detect degradation, and
 * optionally auto-trigger re-compaction.
 *
 * Call this after each compaction event (after `compactMessages` or
 * `checkAndCompact` has modified the message list).
 *
 * @param messages         - current message list (mutated if re-compaction fires)
 * @param state            - mutable degradation tracking state
 * @param config           - degradation monitoring configuration
 * @param compactionConfig - standard compaction config (for re-compaction)
 * @param turn             - current agent turn number
 * @param originalTexts    - text of messages that were just compacted
 * @param summaryText      - text of the summary that was just produced
 * @param summarizer       - optional custom summarizer for re-compaction
 * @param patterns         - optional custom significant-token patterns
 */
export async function monitorCompactionQuality(
  messages: Message[],
  state: CompactionDegradationState,
  config: CompactionDegradationConfig,
  compactionConfig: CompactionConfig,
  turn: number,
  originalTexts: string[],
  summaryText: string,
  summarizer?: (messages: Message[], config: CompactionConfig) => Promise<string>,
  patterns?: RegExp[],
): Promise<CompactionDegradationReport> {
  if (!config.enabled) {
    return {
      degraded: false,
      currentQuality: 1,
      averageQuality: state.averageQuality,
      trend: "stable",
      recompactTriggered: false,
      reason: null,
    };
  }

  // --- Record quality for this compaction ----------------------------
  recordCompaction(state, turn, originalTexts, summaryText, patterns);

  const latest = state.snapshots[state.snapshots.length - 1]!;
  const trend = analyzeQualityTrend(state.snapshots, config.windowSize);

  // --- Check for degradation -----------------------------------------
  const qualityBelowThreshold = latest.qualityScore < config.qualityThreshold;
  const trendDeclining = trend === "declining";
  const avgBelowThreshold =
    state.snapshots.length >= config.windowSize &&
    state.averageQuality < config.qualityThreshold;

  const degraded = qualityBelowThreshold || (trendDeclining && avgBelowThreshold);

  let reason: string | null = null;
  if (degraded) {
    const reasons: string[] = [];
    if (qualityBelowThreshold) {
      reasons.push(
        `Quality score ${latest.qualityScore.toFixed(2)} below threshold ${config.qualityThreshold}`,
      );
    }
    if (trendDeclining) {
      reasons.push("quality trend is declining");
    }
    if (avgBelowThreshold) {
      reasons.push(
        `average quality ${state.averageQuality.toFixed(2)} below threshold`,
      );
    }
    reason = `Compaction quality degraded: ${reasons.join("; ")}. Significant-token retention: ${(latest.significantTokenRetention * 100).toFixed(0)}%`;
  }

  // --- Auto re-compaction --------------------------------------------
  let recompactTriggered = false;
  if (degraded && shouldRecompact(state, config)) {
    const recompacted = await triggerRecompact(
      messages,
      state,
      config,
      compactionConfig,
      turn,
      summarizer,
    );
    // Mutate messages in-place (same contract as compactMessages).
    if (recompacted !== messages) {
      messages.length = 0;
      messages.push(...recompacted);
      recompactTriggered = true;
    }
  }

  return {
    degraded,
    currentQuality: latest.qualityScore,
    averageQuality: state.averageQuality,
    trend,
    recompactTriggered,
    reason,
  };
}

// ---------------------------------------------------------------------------
// getCompactionStats — statistics summary
// ---------------------------------------------------------------------------

/** Aggregate compaction quality statistics. */
export type CompactionStats = {
  /** Total compactions observed. */
  totalCompactions: number;
  /** Total re-compactions triggered. */
  recompactions: number;
  /** Average quality across all compactions. */
  averageQuality: number;
  /** Best (highest) quality score seen. */
  bestQuality: number;
  /** Worst (lowest) quality score seen. */
  worstQuality: number;
  /** Average compression ratio. */
  averageCompressionRatio: number;
  /** Average significant-token retention. */
  averageRetention: number;
  /** Current trend. */
  trend: QualityTrend;
};

/**
 * Compute aggregate statistics from the degradation state.
 */
export function getCompactionStats(
  state: CompactionDegradationState,
  windowSize: number,
): CompactionStats {
  const { snapshots } = state;
  if (snapshots.length === 0) {
    return {
      totalCompactions: state.totalCompactions,
      recompactions: state.recompactionCount,
      averageQuality: state.averageQuality,
      bestQuality: 1,
      worstQuality: 1,
      averageCompressionRatio: 0,
      averageRetention: 1,
      trend: "stable",
    };
  }

  let best = 0;
  let worst = 1;
  let sumCompression = 0;
  let sumRetention = 0;
  for (const snap of snapshots) {
    if (snap.qualityScore > best) best = snap.qualityScore;
    if (snap.qualityScore < worst) worst = snap.qualityScore;
    sumCompression += snap.compressionRatio;
    sumRetention += snap.significantTokenRetention;
  }

  return {
    totalCompactions: state.totalCompactions,
    recompactions: state.recompactionCount,
    averageQuality: state.averageQuality,
    bestQuality: best,
    worstQuality: worst,
    averageCompressionRatio: sumCompression / snapshots.length,
    averageRetention: sumRetention / snapshots.length,
    trend: analyzeQualityTrend(snapshots, windowSize),
  };
}
