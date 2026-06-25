// Tests for preemptive compaction — proactive context compression and
// degradation monitoring.

import { describe, expect, it } from "vitest";

import type { CompactionConfig, Message, TokenBudget } from "./types";
import {
  checkAndCompact,
  checkDegradation,
  createPreemptiveState,
  DEFAULT_PREEMPTIVE_COMPACTION,
  estimateGrowthRate,
  projectNextTurnTokens,
} from "./preemptive-compaction";

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

function makeBudget(total: number, opts?: Partial<TokenBudget>): TokenBudget {
  return {
    total,
    reserved: opts?.reserved ?? Math.floor(total * 0.2),
    available: opts?.available ?? Math.floor(total * 0.8),
    used: opts?.used ?? 0,
    keepRecent: opts?.keepRecent ?? 6,
  };
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

/** Fill messages until approximate token count is reached. */
function fillMessages(targetTokens: number): Message[] {
  const msgs: Message[] = [];
  let accumulated = 0;
  let i = 0;
  while (accumulated < targetTokens) {
    // Each message ~100 chars = 25 tokens
    const content = `message content number ${i} with some padding text to reach token target`;
    msgs.push(makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    accumulated += Math.ceil(content.length / 4);
    i++;
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// estimateGrowthRate
// ---------------------------------------------------------------------------

describe("estimateGrowthRate", () => {
  it("returns 0 with fewer than 2 data points", () => {
    const state = createPreemptiveState();
    expect(estimateGrowthRate(state, 3)).toBe(0);

    state.tokenHistory.push(100);
    expect(estimateGrowthRate(state, 3)).toBe(0);
  });

  it("computes linear slope from recent window", () => {
    const state = createPreemptiveState();
    state.tokenHistory.push(100, 200, 300, 400, 500);
    // Window 3 → last 3: [300, 400, 500] → slope = (500-300)/2 = 100
    expect(estimateGrowthRate(state, 3)).toBe(100);
  });

  it("uses all history when window exceeds history length", () => {
    const state = createPreemptiveState();
    state.tokenHistory.push(0, 100);
    // Window 5 but only 2 points → slope = (100 - 0) / 1 = 100
    expect(estimateGrowthRate(state, 5)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// projectNextTurnTokens
// ---------------------------------------------------------------------------

describe("projectNextTurnTokens", () => {
  it("returns current + growth rate floored", () => {
    expect(projectNextTurnTokens(1000, 150.7)).toBe(1150);
  });

  it("floors at 0 for negative growth", () => {
    expect(projectNextTurnTokens(10, -100)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkDegradation
// ---------------------------------------------------------------------------

describe("checkDegradation", () => {
  it("returns not degraded with < 2 snapshots", () => {
    const state = createPreemptiveState();
    state.degradationSnapshots.push({ turn: 1, compactions: 0 });
    const result = checkDegradation(state, DEFAULT_PREEMPTIVE_COMPACTION);
    expect(result.degraded).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("returns not degraded when compaction count is below threshold", () => {
    const state = createPreemptiveState();
    state.compactionCount = 2;
    state.turnCount = 10;
    state.degradationSnapshots = [
      { turn: 1, compactions: 0 },
      { turn: 10, compactions: 2 },
    ];
    const result = checkDegradation(state, DEFAULT_PREEMPTIVE_COMPACTION);
    expect(result.degraded).toBe(false);
  });

  it("detects degradation when rate is high and count exceeds max", () => {
    const state = createPreemptiveState();
    state.compactionCount = 8;
    state.turnCount = 10;
    state.degradationSnapshots = [
      { turn: 1, compactions: 0 },
      { turn: 10, compactions: 8 },
    ];
    // rate = 8/9 ≈ 0.89, count 8 > maxCompactionsBeforeWarning 5
    const result = checkDegradation(state, DEFAULT_PREEMPTIVE_COMPACTION);
    expect(result.degraded).toBe(true);
    expect(result.compactionRate).toBeCloseTo(8 / 9);
    expect(result.reason).toContain("Compaction rate");
  });

  it("respects maxCompactionsBeforeWarning = 0 (disabled)", () => {
    const state = createPreemptiveState();
    state.compactionCount = 100;
    state.turnCount = 10;
    state.degradationSnapshots = [
      { turn: 1, compactions: 0 },
      { turn: 10, compactions: 100 },
    ];
    const config = {
      ...DEFAULT_PREEMPTIVE_COMPACTION,
      maxCompactionsBeforeWarning: 0,
    };
    const result = checkDegradation(state, config);
    expect(result.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createPreemptiveState
// ---------------------------------------------------------------------------

describe("createPreemptiveState", () => {
  it("initializes with empty tracking data", () => {
    const state = createPreemptiveState();
    expect(state.tokenHistory).toEqual([]);
    expect(state.compactionCount).toBe(0);
    expect(state.turnCount).toBe(0);
    expect(state.tokensAfterLastCompaction).toBe(0);
    expect(state.degradationSnapshots).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkAndCompact
// ---------------------------------------------------------------------------

describe("checkAndCompact", () => {
  it("does nothing when usage is well within budget", async () => {
    const messages = [makeMessage("user", "hello")];
    const budget = makeBudget(100_000);
    const preemptiveState = createPreemptiveState();

    const result = await checkAndCompact({
      messages,
      tokenBudget: budget,
      compactionConfig: makeCompactionConfig(),
      preemptiveConfig: DEFAULT_PREEMPTIVE_COMPACTION,
      preemptiveState,
    });

    expect(result.compacted).toBe(false);
    expect(result.strategy).toBe("none");
    expect(preemptiveState.turnCount).toBe(1);
    expect(preemptiveState.tokenHistory).toHaveLength(1);
  });

  it("fires preemptive compaction when projected usage exceeds trigger", async () => {
    // Small budget so we can easily exceed the trigger threshold.
    const total = 500;
    const budget = makeBudget(total);
    const preemptiveState = createPreemptiveState();

    // Seed history so growth rate predicts we'll exceed 70% next turn.
    // With triggerThreshold 0.7 and total 500, we need projected >= 350.
    preemptiveState.tokenHistory = [200, 280, 340];

    // Current messages that put us at ~340 tokens (just under 70% = 350).
    // Growth rate from [200, 280, 340] = (340-200)/2 = 70/turn.
    // Projected = 340 + 70 = 410 ≥ 350 → should trigger.
    const messages = fillMessages(340);

    const result = await checkAndCompact({
      messages,
      tokenBudget: budget,
      compactionConfig: makeCompactionConfig({
        keepRecentTokens: 80,
        threshold: 0.8,
      }),
      preemptiveConfig: DEFAULT_PREEMPTIVE_COMPACTION,
      preemptiveState,
    });

    expect(result.compacted).toBe(true);
    expect(result.strategy).toBe("preemptive");
    expect(preemptiveState.compactionCount).toBe(1);
    // Messages should be shorter after compaction.
    expect(messages.length).toBeLessThan(340 / 25 + 2);
  });

  it("fires reactive compaction when projected usage is below trigger but current exceeds hard threshold", async () => {
    const total = 1000;
    const budget = makeBudget(total);
    const preemptiveState = createPreemptiveState();

    // checkAndCompact pushes currentTokens to tokenHistory BEFORE computing
    // growth rate.  So seed [2000, 1200, 1100]; after push of ~860:
    // history = [2000, 1200, 1100, ~860]; window 3 → [1200, 1100, ~860].
    // growth = (~860 - 1200) / 2 ≈ -170
    // projected ≈ 860 + (-170) = 690 → ratio ≈ 0.690 < 0.7 → preemptive skips.
    // current ≈ 860 → ratio ≈ 0.860 > 0.8 → reactive fires.
    preemptiveState.tokenHistory = [2000, 1200, 1100];

    const messages = fillMessages(850);

    const result = await checkAndCompact({
      messages,
      tokenBudget: budget,
      compactionConfig: makeCompactionConfig({
        keepRecentTokens: 80,
        threshold: 0.8,
      }),
      preemptiveConfig: DEFAULT_PREEMPTIVE_COMPACTION,
      preemptiveState,
    });

    expect(result.compacted).toBe(true);
    expect(result.strategy).toBe("reactive");
  });

  it("skips preemptive when disabled but still does reactive", async () => {
    const total = 500;
    const budget = makeBudget(total);
    const preemptiveState = createPreemptiveState();
    const messages = fillMessages(420);

    const result = await checkAndCompact({
      messages,
      tokenBudget: budget,
      compactionConfig: makeCompactionConfig({
        keepRecentTokens: 80,
        threshold: 0.8,
      }),
      preemptiveConfig: { ...DEFAULT_PREEMPTIVE_COMPACTION, enabled: false },
      preemptiveState,
    });

    expect(result.compacted).toBe(true);
    expect(result.strategy).toBe("reactive");
  });

  it("skips everything when compaction is disabled", async () => {
    const total = 500;
    const budget = makeBudget(total);
    const preemptiveState = createPreemptiveState();
    const messages = fillMessages(420);

    const result = await checkAndCompact({
      messages,
      tokenBudget: budget,
      compactionConfig: makeCompactionConfig({ enabled: false }),
      preemptiveConfig: DEFAULT_PREEMPTIVE_COMPACTION,
      preemptiveState,
    });

    expect(result.compacted).toBe(false);
    expect(result.strategy).toBe("none");
  });

  it("tracks degradation over multiple compactions", async () => {
    const total = 200;
    const budget = makeBudget(total);
    const preemptiveState = createPreemptiveState();

    // Run multiple turns, each time filling messages to trigger compaction.
    for (let i = 0; i < 6; i++) {
      const messages = fillMessages(180);
      await checkAndCompact({
        messages,
        tokenBudget: budget,
        compactionConfig: makeCompactionConfig({
          keepRecentTokens: 40,
          threshold: 0.8,
        }),
        preemptiveConfig: {
          ...DEFAULT_PREEMPTIVE_COMPACTION,
          triggerThreshold: 0.5, // aggressively low to guarantee preemptive fires
          growthRateWindow: 2,
        },
        preemptiveState,
      });
    }

    expect(preemptiveState.compactionCount).toBeGreaterThanOrEqual(5);
    expect(preemptiveState.turnCount).toBe(6);
    expect(preemptiveState.degradationSnapshots.length).toBe(6);

    // The last snapshot should reflect the compaction count.
    const last =
      preemptiveState.degradationSnapshots[
        preemptiveState.degradationSnapshots.length - 1
      ]!;
    expect(last.compactions).toBe(preemptiveState.compactionCount);
  });

  it("preserves system messages during compaction", async () => {
    const total = 500;
    const budget = makeBudget(total);
    const preemptiveState = createPreemptiveState();
    preemptiveState.tokenHistory = [200, 280, 340];

    const systemMsg = makeMessage("system", "You are a helpful assistant.");
    const messages = [systemMsg, ...fillMessages(340)];

    await checkAndCompact({
      messages,
      tokenBudget: budget,
      compactionConfig: makeCompactionConfig({
        keepRecentTokens: 80,
        threshold: 0.8,
      }),
      preemptiveConfig: DEFAULT_PREEMPTIVE_COMPACTION,
      preemptiveState,
    });

    // System messages should survive compaction.
    const systemMsgs = messages.filter((m) => m.role === "system");
    expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
  });
});
