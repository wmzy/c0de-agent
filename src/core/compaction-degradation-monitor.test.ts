// Tests for compaction degradation monitor — quality tracking, degradation
// detection, re-compaction fallback, and statistics.

import { describe, expect, it, vi } from "vitest";

import type { CompactionConfig, Message } from "./types";
import {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  role: "user" | "assistant" | "system",
  content: string,
  id = `msg-${Math.random().toString(36).slice(2, 8)}`,
): Message {
  return { id, role, content, createdAt: Date.now() };
}

function makeCompactionConfig(
  overrides?: Partial<CompactionConfig>,
): CompactionConfig {
  return {
    enabled: true,
    threshold: 0.8,
    reserveTokens: 2000,
    keepRecentTokens: 4000,
    ...overrides,
  };
}

/**
 * Generate enough messages that compactMessages will actually move older
 * messages out of the "recent" window.  Each message is ~400 chars (~100
 * tokens).  With keepRecentTokens=200, we need >2 messages for compaction.
 */
function makeManyMessages(count: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < count; i++) {
    const content = `Message ${i}: The compactMessages function in src/core/context.ts processes token budgets and compaction configs for turn ${i}. `.repeat(3);
    msgs.push(makeMessage(i % 2 === 0 ? "user" : "assistant", content));
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// extractSignificantTokens
// ---------------------------------------------------------------------------

describe("extractSignificantTokens", () => {
  it("returns empty set for empty text", () => {
    const tokens = extractSignificantTokens("");
    expect(tokens.size).toBe(0);
  });

  it("extracts file paths", () => {
    const tokens = extractSignificantTokens(
      "Updated src/core/types.ts and src/llm/index.ts",
    );
    expect(tokens.has("src/core/types.ts")).toBe(true);
    expect(tokens.has("src/llm/index.ts")).toBe(true);
  });

  it("extracts camelCase identifiers", () => {
    const tokens = extractSignificantTokens(
      "The compactMessages function calls estimateMessageTokens",
    );
    expect(tokens.has("compactmessages")).toBe(true);
    expect(tokens.has("estimatemessagetokens")).toBe(true);
  });

  it("extracts snake_case identifiers", () => {
    const tokens = extractSignificantTokens("Set keep_recent_tokens to 4000");
    expect(tokens.has("keep_recent_tokens")).toBe(true);
  });

  it("extracts quoted strings", () => {
    const tokens = extractSignificantTokens('Error type is "compaction_error"');
    expect(tokens.has("compaction_error")).toBe(true);
  });

  it("extracts URLs", () => {
    const tokens = extractSignificantTokens("See https://example.com/api/v1");
    expect(tokens.has("https://example.com/api/v1")).toBe(true);
  });

  it("extracts numeric values with units", () => {
    const tokens = extractSignificantTokens("Threshold is 0.8 and limit is 4000 tokens");
    expect(tokens.has("4000 tokens")).toBe(true);
  });

  it("ignores short tokens (length < 2)", () => {
    const tokens = extractSignificantTokens("a b c x y z");
    expect(tokens.size).toBe(0);
  });

  it("returns deduplicated tokens", () => {
    const tokens = extractSignificantTokens(
      "compactMessages does compactMessages again",
    );
    const compactTokens = [...tokens].filter((t) => t.includes("compactmessages"));
    expect(compactTokens).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// computeQualityScore
// ---------------------------------------------------------------------------

describe("computeQualityScore", () => {
  it("returns 0 for empty original texts", () => {
    expect(computeQualityScore([], "summary")).toBe(0);
  });

  it("returns 0 for empty summary", () => {
    expect(computeQualityScore(["original text"], "")).toBe(0);
  });

  it("returns 0 for both empty", () => {
    expect(computeQualityScore([], "")).toBe(0);
  });

  it("gives high score when significant tokens are retained at ideal ratio", () => {
    // Long original → short summary with all key identifiers retained.
    // Original ~400 chars, summary ~100 chars → ratio ~0.25 (sweet spot).
    const originals = [
      "The compactMessages function in src/core/context.ts processes TokenBudget validation with CompactionConfig settings for estimateTokens calculation at turn 42 and provides a passthroughSummarizer fallback for all error handling paths throughout the codebase module system and export declarations that are used across the project",
    ];
    const summary = "compactMessages src/core/context.ts TokenBudget CompactionConfig estimateTokens";
    const score = computeQualityScore(originals, summary);
    expect(score).toBeGreaterThan(0.7);
  });

  it("gives low score when significant tokens are lost", () => {
    const originals = [
      "The compactMessages function processes src/core/context.ts with TokenBudget validation",
    ];
    const summary = "something completely different happened today";
    const score = computeQualityScore(originals, summary);
    expect(score).toBeLessThan(0.3);
  });

  it("penalizes over-compression (summary too short)", () => {
    const originals = ["a".repeat(1000)];
    const summary = "x";
    const score = computeQualityScore(originals, summary);
    expect(score).toBeLessThan(0.5);
  });

  it("penalizes under-compression (summary nearly same length)", () => {
    const originals = ["a".repeat(1000)];
    const summary = "a".repeat(950);
    const score = computeQualityScore(originals, summary);
    expect(score).toBeLessThan(0.7);
  });

  it("accepts custom patterns", () => {
    const customPatterns = [/\b[A-Z]{3,}\b/g]; // Acronyms
    const originals = ["The API returned OK status"];
    const summary = "API OK status confirmed";
    const score = computeQualityScore(originals, summary, customPatterns);
    expect(score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createDegradationState
// ---------------------------------------------------------------------------

describe("createDegradationState", () => {
  it("initializes with empty snapshots and zero counters", () => {
    const state = createDegradationState();
    expect(state.snapshots).toEqual([]);
    expect(state.recompactionCount).toBe(0);
    expect(state.totalCompactions).toBe(0);
    expect(state.averageQuality).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// analyzeQualityTrend
// ---------------------------------------------------------------------------

describe("analyzeQualityTrend", () => {
  it("returns stable with fewer than 2 snapshots", () => {
    const trend = analyzeQualityTrend(
      [{ turn: 1, qualityScore: 0.5, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.8 }],
      5,
    );
    expect(trend).toBe("stable");
  });

  it("returns stable with empty snapshots", () => {
    expect(analyzeQualityTrend([], 5)).toBe("stable");
  });

  it("detects improving trend", () => {
    const snapshots = [
      { turn: 1, qualityScore: 0.3, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.3 },
      { turn: 2, qualityScore: 0.4, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.4 },
      { turn: 3, qualityScore: 0.5, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.5 },
      { turn: 4, qualityScore: 0.6, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.6 },
      { turn: 5, qualityScore: 0.7, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.7 },
    ];
    expect(analyzeQualityTrend(snapshots, 5)).toBe("improving");
  });

  it("detects declining trend", () => {
    const snapshots = [
      { turn: 1, qualityScore: 0.9, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.9 },
      { turn: 2, qualityScore: 0.8, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.8 },
      { turn: 3, qualityScore: 0.7, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.7 },
      { turn: 4, qualityScore: 0.6, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.6 },
      { turn: 5, qualityScore: 0.5, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.5 },
    ];
    expect(analyzeQualityTrend(snapshots, 5)).toBe("declining");
  });

  it("returns stable when scores fluctuate", () => {
    const snapshots = [
      { turn: 1, qualityScore: 0.5, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.5 },
      { turn: 2, qualityScore: 0.6, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.6 },
      { turn: 3, qualityScore: 0.5, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.5 },
      { turn: 4, qualityScore: 0.6, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.6 },
    ];
    expect(analyzeQualityTrend(snapshots, 5)).toBe("stable");
  });

  it("respects window size parameter", () => {
    const snapshots = [
      { turn: 1, qualityScore: 0.9, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.9 },
      { turn: 2, qualityScore: 0.8, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.8 },
      { turn: 3, qualityScore: 0.5, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.5 },
      { turn: 4, qualityScore: 0.6, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.6 },
      { turn: 5, qualityScore: 0.7, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.7 },
    ];
    // Window 3 → last 3: [0.5, 0.6, 0.7] → improving
    expect(analyzeQualityTrend(snapshots, 3)).toBe("improving");
    // Window 5 → all 5: [0.9, 0.8, 0.5, 0.6, 0.7] → declining slope
    expect(analyzeQualityTrend(snapshots, 5)).toBe("declining");
  });
});

// ---------------------------------------------------------------------------
// recordCompaction
// ---------------------------------------------------------------------------

describe("recordCompaction", () => {
  it("appends a snapshot with computed quality metrics", () => {
    const state = createDegradationState();
    const originals = [
      "The compactMessages function processes src/core/context.ts with TokenBudget validation",
    ];
    const summary = "compactMessages handles src/core/context.ts and TokenBudget";

    recordCompaction(state, 1, originals, summary);

    expect(state.snapshots).toHaveLength(1);
    expect(state.totalCompactions).toBe(1);

    const snap = state.snapshots[0]!;
    expect(snap.turn).toBe(1);
    expect(snap.qualityScore).toBeGreaterThan(0);
    expect(snap.qualityScore).toBeLessThanOrEqual(1);
    expect(snap.originalTokens).toBeGreaterThan(0);
    expect(snap.summaryTokens).toBeGreaterThan(0);
    expect(snap.compressionRatio).toBeGreaterThan(0);
    expect(snap.significantTokenRetention).toBeGreaterThan(0);
    expect(snap.significantTokenRetention).toBeLessThanOrEqual(1);
  });

  it("updates running average quality across multiple calls", () => {
    const state = createDegradationState();

    // First: good quality (ratio ~0.25, significant tokens retained)
    recordCompaction(
      state,
      1,
      ["compactMessages src/core/context.ts TokenBudget CompactionConfig estimateTokens"],
      "compactMessages src/core/context.ts TokenBudget",
    );
    const firstAvg = state.averageQuality;
    expect(firstAvg).toBeGreaterThan(0.5);

    // Second: bad quality
    recordCompaction(state, 2, ["text two"], "completely different");
    expect(state.averageQuality).not.toBe(firstAvg);
    expect(state.totalCompactions).toBe(2);
  });

  it("computes correct compression ratio", () => {
    const state = createDegradationState();
    const original = "a".repeat(400); // ~100 tokens
    const summary = "a".repeat(100); // ~25 tokens

    recordCompaction(state, 1, [original], summary);

    const snap = state.snapshots[0]!;
    expect(snap.compressionRatio).toBeCloseTo(0.25, 1);
  });
});

// ---------------------------------------------------------------------------
// shouldRecompact
// ---------------------------------------------------------------------------

describe("shouldRecompact", () => {
  it("returns false when disabled", () => {
    const state = createDegradationState();
    state.snapshots.push({
      turn: 1, qualityScore: 0.1, originalTokens: 100,
      summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.2,
    });
    const config = { ...DEFAULT_DEGRADATION_CONFIG, enabled: false };
    expect(shouldRecompact(state, config)).toBe(false);
  });

  it("returns false when recompactEnabled is false", () => {
    const state = createDegradationState();
    state.snapshots.push({
      turn: 1, qualityScore: 0.1, originalTokens: 100,
      summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.2,
    });
    const config = { ...DEFAULT_DEGRADATION_CONFIG, recompactEnabled: false };
    expect(shouldRecompact(state, config)).toBe(false);
  });

  it("returns false when max recompactions reached", () => {
    const state = createDegradationState();
    state.recompactionCount = 3;
    state.snapshots.push({
      turn: 1, qualityScore: 0.1, originalTokens: 100,
      summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.2,
    });
    expect(shouldRecompact(state, DEFAULT_DEGRADATION_CONFIG)).toBe(false);
  });

  it("returns false with no snapshots", () => {
    const state = createDegradationState();
    expect(shouldRecompact(state, DEFAULT_DEGRADATION_CONFIG)).toBe(false);
  });

  it("returns false when quality is above threshold", () => {
    const state = createDegradationState();
    state.snapshots.push({
      turn: 1, qualityScore: 0.8, originalTokens: 100,
      summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.8,
    });
    expect(shouldRecompact(state, DEFAULT_DEGRADATION_CONFIG)).toBe(false);
  });

  it("returns true when quality is below threshold and recompactions remain", () => {
    const state = createDegradationState();
    state.snapshots.push({
      turn: 1, qualityScore: 0.3, originalTokens: 100,
      summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.3,
    });
    expect(shouldRecompact(state, DEFAULT_DEGRADATION_CONFIG)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// monitorCompactionQuality — main entry point
// ---------------------------------------------------------------------------

describe("monitorCompactionQuality", () => {
  it("returns non-degraded when monitoring is disabled", async () => {
    const state = createDegradationState();
    const messages = [makeMessage("user", "hello")];
    const config = { ...DEFAULT_DEGRADATION_CONFIG, enabled: false };

    const report = await monitorCompactionQuality(
      messages,
      state,
      config,
      makeCompactionConfig(),
      1,
      ["original text"],
      "summary text",
    );

    expect(report.degraded).toBe(false);
    expect(report.recompactTriggered).toBe(false);
    expect(report.reason).toBeNull();
    expect(state.snapshots).toHaveLength(0);
  });

  it("records snapshot and reports non-degraded for good quality", async () => {
    const state = createDegradationState();
    const messages = [makeMessage("user", "hello")];
    const originals = [
      "The compactMessages function processes src/core/context.ts with TokenBudget validation for CompactionConfig settings",
    ];
    const summary = "compactMessages handles src/core/context.ts and TokenBudget";

    const report = await monitorCompactionQuality(
      messages,
      state,
      DEFAULT_DEGRADATION_CONFIG,
      makeCompactionConfig(),
      1,
      originals,
      summary,
    );

    // Quality is good → no recompact → 1 snapshot from recordCompaction
    expect(state.snapshots).toHaveLength(1);
    expect(report.degraded).toBe(false);
    expect(report.currentQuality).toBeGreaterThan(0);
    expect(report.trend).toBe("stable"); // Only 1 snapshot
  });

  it("detects degradation when quality is below threshold", async () => {
    // Use small keepRecentTokens so messages are compactable
    const messages = makeManyMessages(10);
    const compactionConfig = makeCompactionConfig({ keepRecentTokens: 200 });
    const state = createDegradationState();

    // Originals are the actual message content
    const originals = messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
    // Bad summary that loses all significant tokens
    const summary = "nothing relevant here at all";

    const report = await monitorCompactionQuality(
      messages,
      state,
      DEFAULT_DEGRADATION_CONFIG,
      compactionConfig,
      1,
      originals,
      summary,
    );

    expect(report.degraded).toBe(true);
    expect(report.reason).toContain("below threshold");
  });

  it("detects degradation from declining trend", async () => {
    const state = createDegradationState();
    const messages = makeManyMessages(10);
    const compactionConfig = makeCompactionConfig({ keepRecentTokens: 200 });
    const config = {
      ...DEFAULT_DEGRADATION_CONFIG,
      qualityThreshold: 0.35, // Low threshold so individual scores pass
      windowSize: 5,
    };

    // Seed 4 good snapshots
    for (let i = 0; i < 4; i++) {
      state.snapshots.push({
        turn: i + 1,
        qualityScore: 0.9 - i * 0.02,
        originalTokens: 100,
        summaryTokens: 30,
        compressionRatio: 0.3,
        significantTokenRetention: 0.9 - i * 0.02,
      });
    }
    state.totalCompactions = 4;
    state.averageQuality = state.snapshots.reduce((s, snap) => s + snap.qualityScore, 0) / 4;

    const originals = messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );

    // Add a significantly lower quality compaction
    const report = await monitorCompactionQuality(
      messages,
      state,
      config,
      compactionConfig,
      5,
      originals,
      "something unrelated",
    );

    // 4 seeded + 1 from recordCompaction + possible 1 from recompact = 5 or 6
    expect(state.snapshots.length).toBeGreaterThanOrEqual(5);
    expect(report.trend).toBe("declining");
  });

  it("includes multiple degradation reasons in the report", async () => {
    const state = createDegradationState();
    const messages = makeManyMessages(10);
    const compactionConfig = makeCompactionConfig({ keepRecentTokens: 200 });
    const config = {
      ...DEFAULT_DEGRADATION_CONFIG,
      qualityThreshold: 0.99,
      recompactEnabled: false, // Prevent recompact so we see original state
    };

    const originals = messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );

    const report = await monitorCompactionQuality(
      messages,
      state,
      config,
      compactionConfig,
      1,
      originals,
      "brief summary",
    );

    expect(report.degraded).toBe(true);
    expect(report.reason).toContain("below threshold");
  });
});

// ---------------------------------------------------------------------------
// triggerRecompact — fallback strategy
// ---------------------------------------------------------------------------

describe("triggerRecompact", () => {
  it("returns original messages when compactMessages returns same reference (nothing to compact)", async () => {
    const state = createDegradationState();
    // Only 1 message, keepRecentTokens=4000 — nothing goes to "older"
    const messages = [makeMessage("user", "hello")];

    const result = await triggerRecompact(
      messages,
      state,
      DEFAULT_DEGRADATION_CONFIG,
      makeCompactionConfig(),
      1,
    );

    // compactMessages returns same reference (older.length === 0)
    expect(result).toBe(messages);
    // recompactionCount still increments (no error, just nothing to compact)
    expect(state.recompactionCount).toBe(1);
  });

  it("actually compacts when enough messages exist", async () => {
    const state = createDegradationState();
    // Need many messages so even the relaxed config (keepRecent + bonus) can't
    // cover them all.  50 msgs × ~100 tokens = ~5000; relaxed = 200+1000=1200.
    const messages = makeManyMessages(50);
    const compactionConfig = makeCompactionConfig({ keepRecentTokens: 200 });

    const result = await triggerRecompact(
      messages,
      state,
      DEFAULT_DEGRADATION_CONFIG,
      compactionConfig,
      1,
    );

    // With many messages and small keepRecentTokens, compaction produces new array
    expect(result).not.toBe(messages);
    expect(result.length).toBeLessThan(messages.length);
    expect(state.recompactionCount).toBe(1);
  });

  it("increments recompactionCount on successful compaction", async () => {
    const state = createDegradationState();
    const messages = makeManyMessages(10);
    const compactionConfig = makeCompactionConfig({ keepRecentTokens: 200 });

    await triggerRecompact(
      messages,
      state,
      DEFAULT_DEGRADATION_CONFIG,
      compactionConfig,
      1,
    );

    expect(state.recompactionCount).toBe(1);
  });

  it("passes relaxed config with bonus keep-recent tokens to summarizer", async () => {
    const state = createDegradationState();
    // 50 msgs × ~100 tokens = ~5000; relaxed = 200+3000=3200, still leaves ~18 msgs in older
    const messages = makeManyMessages(50);
    const compactionConfig = makeCompactionConfig({ keepRecentTokens: 200 });
    const summarizer = vi.fn().mockResolvedValue("summary of everything");
    const config = {
      ...DEFAULT_DEGRADATION_CONFIG,
      recompactKeepBonus: 3000,
    };

    await triggerRecompact(messages, state, config, compactionConfig, 1, summarizer);

    expect(summarizer).toHaveBeenCalled();
    const calledConfig = summarizer.mock.calls[0]![1] as CompactionConfig;
    expect(calledConfig.keepRecentTokens).toBe(3200); // 200 + 3000
  });

  it("records quality snapshot from the re-compaction", async () => {
    const state = createDegradationState();
    const messages = makeManyMessages(50);
    const compactionConfig = makeCompactionConfig({ keepRecentTokens: 200 });

    await triggerRecompact(
      messages,
      state,
      DEFAULT_DEGRADATION_CONFIG,
      compactionConfig,
      1,
    );

    // triggerRecompact calls recordCompaction internally
    expect(state.snapshots.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// getCompactionStats
// ---------------------------------------------------------------------------

describe("getCompactionStats", () => {
  it("returns default stats with empty snapshots", () => {
    const state = createDegradationState();
    const stats = getCompactionStats(state, 5);

    expect(stats.totalCompactions).toBe(0);
    expect(stats.recompactions).toBe(0);
    expect(stats.averageQuality).toBe(1);
    expect(stats.bestQuality).toBe(1);
    expect(stats.worstQuality).toBe(1);
    expect(stats.averageCompressionRatio).toBe(0);
    expect(stats.averageRetention).toBe(1);
    expect(stats.trend).toBe("stable");
  });

  it("computes aggregate stats from snapshots", () => {
    const state = createDegradationState();
    state.totalCompactions = 3;
    state.recompactionCount = 1;
    state.averageQuality = 0.7;
    state.snapshots = [
      { turn: 1, qualityScore: 0.9, originalTokens: 200, summaryTokens: 60, compressionRatio: 0.3, significantTokenRetention: 0.85 },
      { turn: 2, qualityScore: 0.7, originalTokens: 150, summaryTokens: 45, compressionRatio: 0.3, significantTokenRetention: 0.7 },
      { turn: 3, qualityScore: 0.5, originalTokens: 100, summaryTokens: 50, compressionRatio: 0.5, significantTokenRetention: 0.5 },
    ];

    const stats = getCompactionStats(state, 5);

    expect(stats.totalCompactions).toBe(3);
    expect(stats.recompactions).toBe(1);
    expect(stats.averageQuality).toBeCloseTo(0.7);
    expect(stats.bestQuality).toBe(0.9);
    expect(stats.worstQuality).toBe(0.5);
    expect(stats.averageCompressionRatio).toBeCloseTo((0.3 + 0.3 + 0.5) / 3);
    expect(stats.averageRetention).toBeCloseTo((0.85 + 0.7 + 0.5) / 3);
    expect(stats.trend).toBe("declining");
  });

  it("detects improving trend in stats", () => {
    const state = createDegradationState();
    state.totalCompactions = 5;
    state.snapshots = [
      { turn: 1, qualityScore: 0.4, originalTokens: 100, summaryTokens: 30, compressionRatio: 0.3, significantTokenRetention: 0.4 },
      { turn: 2, qualityScore: 0.5, originalTokens: 100, summaryTokens: 30, compressionRatio: 0.3, significantTokenRetention: 0.5 },
      { turn: 3, qualityScore: 0.6, originalTokens: 100, summaryTokens: 30, compressionRatio: 0.3, significantTokenRetention: 0.6 },
      { turn: 4, qualityScore: 0.7, originalTokens: 100, summaryTokens: 30, compressionRatio: 0.3, significantTokenRetention: 0.7 },
      { turn: 5, qualityScore: 0.8, originalTokens: 100, summaryTokens: 30, compressionRatio: 0.3, significantTokenRetention: 0.8 },
    ];

    const stats = getCompactionStats(state, 5);
    expect(stats.trend).toBe("improving");
  });
});

// ---------------------------------------------------------------------------
// Integration: monitorCompactionQuality + shouldRecompact + triggerRecompact
// ---------------------------------------------------------------------------

describe("integration: full degradation → recompact flow", () => {
  it("detects degradation and triggers recompaction when enough messages exist", async () => {
    const state = createDegradationState();
    // Need enough messages so relaxed config still leaves older messages
    const messages = makeManyMessages(50);
    const compactionConfig = makeCompactionConfig({ keepRecentTokens: 200 });

    const originals = messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );

    const report = await monitorCompactionQuality(
      messages,
      state,
      DEFAULT_DEGRADATION_CONFIG,
      compactionConfig,
      1,
      originals,
      "vague summary of something",
    );

    // Should detect degradation (quality below threshold)
    expect(report.degraded).toBe(true);
    expect(report.currentQuality).toBeLessThan(DEFAULT_DEGRADATION_CONFIG.qualityThreshold);
    // Should trigger recompaction since quality is below threshold
    expect(report.recompactTriggered).toBe(true);
    expect(state.recompactionCount).toBe(1);
  });

  it("does not recompact when quality is good", async () => {
    const state = createDegradationState();
    const messages = [makeMessage("user", "hello")];

    const report = await monitorCompactionQuality(
      messages,
      state,
      DEFAULT_DEGRADATION_CONFIG,
      makeCompactionConfig(),
      1,
      ["compactMessages src/core/types.ts TokenBudget CompactionConfig"],
      "compactMessages src/core/types.ts TokenBudget CompactionConfig",
    );

    expect(report.degraded).toBe(false);
    expect(report.recompactTriggered).toBe(false);
  });

  it("respects maxRecompactions limit across multiple degradations", async () => {
    const state = createDegradationState();
    const compactionConfig = makeCompactionConfig({ keepRecentTokens: 200 });

    const config = {
      ...DEFAULT_DEGRADATION_CONFIG,
      maxRecompactions: 2,
    };

    // First degradation → recompact #1
    const msgs1 = makeManyMessages(50);
    const originals1 = msgs1.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
    const report1 = await monitorCompactionQuality(
      msgs1, state, config, compactionConfig, 1,
      originals1, "bad summary 1",
    );
    expect(report1.degraded).toBe(true);
    expect(report1.recompactTriggered).toBe(true);
    expect(state.recompactionCount).toBe(1);

    // Second degradation → recompact #2
    const msgs2 = makeManyMessages(50);
    const originals2 = msgs2.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
    const report2 = await monitorCompactionQuality(
      msgs2, state, config, compactionConfig, 2,
      originals2, "bad summary 2",
    );
    expect(report2.degraded).toBe(true);
    expect(report2.recompactTriggered).toBe(true);
    expect(state.recompactionCount).toBe(2);

    // Third degradation → no more recompactions
    const msgs3 = makeManyMessages(50);
    const originals3 = msgs3.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
    const report3 = await monitorCompactionQuality(
      msgs3, state, config, compactionConfig, 3,
      originals3, "bad summary 3",
    );
    expect(report3.degraded).toBe(true);
    expect(report3.recompactTriggered).toBe(false);
    expect(state.recompactionCount).toBe(2);
  });
});
