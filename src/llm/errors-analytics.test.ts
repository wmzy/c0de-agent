// Tests for error analytics: aggregation, trends, reporting, pattern learning.
//
// Covers:
//   - Error history creation and recording
//   - Statistics computation (per-type, per-provider, per-model)
//   - Trend analysis (sliding windows, spike detection, direction)
//   - Error report generation with recommendations
//   - Pattern matching diagnostics
//   - Runtime pattern learning
//   - Enhanced error classification (new categories)

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  analyzeTrends,
  classifyError,
  createErrorHistory,
  generateErrorReport,
  getErrorStats,
  getLearnedPatterns,
  getPatternMatches,
  isContentFilter,
  isModelNotFound,
  isOverloaded,
  isRequestTooLarge,
  isToolError,
  learnPattern,
  pruneHistory,
  recordError,
  removeLearnedPattern,
  shouldRetry,
} from "./errors";

import type { ErrorHistory, StreamChunk } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorChunk(
  message: string,
  code?: string,
  retriable?: boolean,
): StreamChunk & { _tag: "error" } {
  return { _tag: "error", message, code, retriable };
}

/** Record N errors with a time offset. */
function recordBatch(
  history: ErrorHistory,
  errors: Array<{ msg: string; code?: string; provider?: string; model?: string }>,
  startOffsetMs = 0,
): void {
  const baseTime = Date.now() + startOffsetMs;
  for (const { msg, code, provider, model } of errors) {
    const chunk = errorChunk(msg, code);
    const event = recordError(history, chunk, provider, model);
    // Override timestamp for deterministic testing
    event.timestamp = baseTime + history.events.length * 1000;
  }
}

// ---------------------------------------------------------------------------
// Error history creation
// ---------------------------------------------------------------------------

describe("createErrorHistory", () => {
  it("creates empty history with default max", () => {
    const h = createErrorHistory();
    expect(h.events).toEqual([]);
    expect(h.learnedPatterns).toEqual([]);
    expect(h.maxEvents).toBe(10_000);
  });

  it("creates history with custom max", () => {
    const h = createErrorHistory(100);
    expect(h.maxEvents).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// recordError
// ---------------------------------------------------------------------------

describe("recordError", () => {
  it("records an error event with classification", () => {
    const h = createErrorHistory();
    const event = recordError(h, errorChunk("quota exceeded"), "openai", "gpt-4");

    expect(h.events).toHaveLength(1);
    expect(event.classification.type).toBe("quota_exceeded");
    expect(event.provider).toBe("openai");
    expect(event.model).toBe("gpt-4");
    expect(event.retriable).toBe(false);
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it("records retryAfterMs when present in error", () => {
    const h = createErrorHistory();
    const event = recordError(h, errorChunk("rate limited, retry-after: 30"));
    expect(event.retryAfterMs).toBe(30_000);
  });

  it("prunes old events when exceeding maxEvents", () => {
    const h = createErrorHistory(5);
    for (let i = 0; i < 10; i++) {
      recordError(h, errorChunk(`error ${i}`));
    }
    expect(h.events).toHaveLength(5);
    // Most recent events should remain
    expect(h.events[0]!.classification.message).toBe("error 5");
  });
});

// ---------------------------------------------------------------------------
// pruneHistory
// ---------------------------------------------------------------------------

describe("pruneHistory", () => {
  it("removes events older than maxAgeMs", () => {
    const h = createErrorHistory();
    const e1 = recordError(h, errorChunk("old"));
    e1.timestamp = Date.now() - 120_000; // 2 minutes ago

    const e2 = recordError(h, errorChunk("new"));
    e2.timestamp = Date.now() - 10_000; // 10 seconds ago

    pruneHistory(h, 60_000); // keep last 60s
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.classification.message).toBe("new");
  });

  it("trims to maxEvents keeping newest", () => {
    const h = createErrorHistory(3);
    for (let i = 0; i < 6; i++) {
      recordError(h, errorChunk(`err ${i}`));
    }
    pruneHistory(h);
    expect(h.events).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// getErrorStats
// ---------------------------------------------------------------------------

describe("getErrorStats", () => {
  it("computes stats for empty history", () => {
    const h = createErrorHistory();
    const stats = getErrorStats(h);
    expect(stats.total).toBe(0);
    expect(stats.byType).toEqual({});
    expect(stats.byProvider).toEqual({});
    expect(stats.byModel).toEqual({});
  });

  it("computes per-type counts", () => {
    const h = createErrorHistory();
    recordError(h, errorChunk("quota exceeded"));
    recordError(h, errorChunk("quota exceeded"));
    recordError(h, errorChunk("rate limited"));

    const stats = getErrorStats(h);
    expect(stats.total).toBe(3);
    expect(stats.byType.quota_exceeded).toBe(2);
    expect(stats.byType.rate_limited).toBe(1);
  });

  it("computes per-provider counts", () => {
    const h = createErrorHistory();
    recordError(h, errorChunk("err 1"), "openai");
    recordError(h, errorChunk("err 2"), "openai");
    recordError(h, errorChunk("err 3"), "anthropic");

    const stats = getErrorStats(h);
    expect(stats.byProvider.openai).toBe(2);
    expect(stats.byProvider.anthropic).toBe(1);
  });

  it("computes per-model counts", () => {
    const h = createErrorHistory();
    recordError(h, errorChunk("err 1"), "openai", "gpt-4");
    recordError(h, errorChunk("err 2"), "openai", "gpt-4o");
    recordError(h, errorChunk("err 3"), "openai", "gpt-4");

    const stats = getErrorStats(h);
    expect(stats.byModel["gpt-4"]).toBe(2);
    expect(stats.byModel["gpt-4o"]).toBe(1);
  });

  it("filters to time window when specified", () => {
    const h = createErrorHistory();
    const old = recordError(h, errorChunk("old error"));
    old.timestamp = Date.now() - 120_000;

    const recent = recordError(h, errorChunk("recent error"));
    recent.timestamp = Date.now() - 5_000;

    const stats = getErrorStats(h, 60_000);
    expect(stats.total).toBe(1);
    expect(stats.byType.recent_error?.classification).toBeUndefined();
  });

  it("tracks last occurrence per type", () => {
    const h = createErrorHistory();
    const e1 = recordError(h, errorChunk("quota exceeded"));
    e1.timestamp = 1000;
    const e2 = recordError(h, errorChunk("rate limited"));
    e2.timestamp = 2000;
    const e3 = recordError(h, errorChunk("quota exceeded"));
    e3.timestamp = 3000;

    const stats = getErrorStats(h);
    expect(stats.lastOccurrence.quota_exceeded).toBe(3000);
    expect(stats.lastOccurrence.rate_limited).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// analyzeTrends
// ---------------------------------------------------------------------------

describe("analyzeTrends", () => {
  it("returns insufficient_data for empty history", () => {
    const h = createErrorHistory();
    const trend = analyzeTrends(h);
    expect(trend.direction).toBe("stable"); // no data = no change
    expect(trend.windows).toHaveLength(6);
    expect(trend.hotspots).toEqual([]);
  });

  it("detects increasing trend", () => {
    const h = createErrorHistory();
    const now = Date.now();
    // Earlier windows: 1 error; recent windows: 5 errors
    const windowOffsets = [28, 23, 18, 13, 8, 3]; // minutes ago (mid of each 5-min window)
    const counts = [1, 1, 1, 5, 5, 5];

    for (let w = 0; w < 6; w++) {
      for (let i = 0; i < counts[w]!; i++) {
        const event = recordError(h, errorChunk("server error"));
        event.timestamp = now - windowOffsets[w]! * 60_000 + i * 100;
      }
    }

    const trend = analyzeTrends(h, 5 * 60_000, 6);
    expect(trend.direction).toBe("increasing");
  });

  it("detects decreasing trend", () => {
    const h = createErrorHistory();
    const now = Date.now();
    // Earlier windows: 5 errors; recent windows: 1 error
    const windowOffsets = [28, 23, 18, 13, 8, 3];
    const counts = [5, 5, 5, 1, 1, 1];

    for (let w = 0; w < 6; w++) {
      for (let i = 0; i < counts[w]!; i++) {
        const event = recordError(h, errorChunk("server error"));
        event.timestamp = now - windowOffsets[w]! * 60_000 + i * 100;
      }
    }

    const trend = analyzeTrends(h, 5 * 60_000, 6);
    expect(trend.direction).toBe("decreasing");
  });

  it("detects hotspots with spike ratio", () => {
    const h = createErrorHistory();
    const now = Date.now();
    // Earlier windows: 1 error of each type
    for (let i = 0; i < 1; i++) {
      const event = recordError(h, errorChunk("rate limited"));
      event.timestamp = now - 25 * 60_000 + i * 100;
    }
    // Recent windows: 10 errors of rate_limited
    for (let i = 0; i < 10; i++) {
      const event = recordError(h, errorChunk("rate limited"));
      event.timestamp = now - 5 * 60_000 + i * 100;
    }

    const trend = analyzeTrends(h, 5 * 60_000, 6);
    const hotspot = trend.hotspots.find((h) => h.type === "rate_limited");
    expect(hotspot).toBeDefined();
    expect(hotspot!.spikeRatio).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// generateErrorReport
// ---------------------------------------------------------------------------

describe("generateErrorReport", () => {
  it("generates report with all sections", () => {
    const h = createErrorHistory();
    recordError(h, errorChunk("quota exceeded"), "openai", "gpt-4");
    recordError(h, errorChunk("rate limited"), "anthropic", "claude-3");

    const report = generateErrorReport(h);
    expect(report.generatedAt).toBeGreaterThan(0);
    expect(report.period.startMs).toBeLessThan(report.period.endMs);
    expect(report.summary.total).toBe(2);
    expect(report.trends.windows).toHaveLength(6);
    expect(report.topErrors.length).toBeGreaterThan(0);
    expect(Array.isArray(report.recommendations)).toBe(true);
  });

  it("ranks top errors by count", () => {
    const h = createErrorHistory();
    for (let i = 0; i < 5; i++) {
      recordError(h, errorChunk("quota exceeded"), "openai");
    }
    recordError(h, errorChunk("rate limited"), "anthropic");

    const report = generateErrorReport(h);
    expect(report.topErrors[0]!.classification.type).toBe("quota_exceeded");
    expect(report.topErrors[0]!.count).toBe(5);
  });

  it("includes provider info in top errors", () => {
    const h = createErrorHistory();
    recordError(h, errorChunk("quota exceeded"), "openai");
    recordError(h, errorChunk("quota exceeded"), "anthropic");

    const report = generateErrorReport(h);
    const quotaEntry = report.topErrors.find(
      (e) => e.classification.type === "quota_exceeded",
    );
    expect(quotaEntry!.providers).toContain("openai");
    expect(quotaEntry!.providers).toContain("anthropic");
  });

  it("generates recommendations for auth errors", () => {
    const h = createErrorHistory();
    for (let i = 0; i < 10; i++) {
      recordError(h, errorChunk("invalid api key"));
    }

    const report = generateErrorReport(h);
    expect(report.recommendations.some((r) => r.includes("authentication"))).toBe(true);
  });

  it("filters report to specified period", () => {
    const h = createErrorHistory();
    const old = recordError(h, errorChunk("old error"));
    old.timestamp = Date.now() - 120_000;
    const recent = recordError(h, errorChunk("recent error"));
    recent.timestamp = Date.now() - 5_000;

    const report = generateErrorReport(h, 60_000);
    expect(report.summary.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getPatternMatches
// ---------------------------------------------------------------------------

describe("getPatternMatches", () => {
  it("identifies matching patterns for overflow", () => {
    const result = getPatternMatches(errorChunk("context_length_exceeded"));
    expect(result.errorType).toBe("context_overflow");
    expect(result.matchedPatterns.length).toBeGreaterThan(0);
  });

  it("identifies matching error codes", () => {
    const result = getPatternMatches(errorChunk("some message", "insufficient_quota"));
    expect(result.matchedCodes).toContain("insufficient_quota");
  });

  it("returns empty matches for no-match error", () => {
    const result = getPatternMatches(errorChunk("completely unrelated message"));
    expect(result.matchedPatterns).toHaveLength(0);
  });

  it("includes learned pattern matches", () => {
    const h = createErrorHistory();
    learnPattern(h, "custom_auth", /my_custom_auth_error/i);

    const result = getPatternMatches(errorChunk("my_custom_auth_error occurred"), h);
    expect(result.learnedMatches).toContain("custom_auth");
  });
});

// ---------------------------------------------------------------------------
// Pattern learning
// ---------------------------------------------------------------------------

describe("learnPattern", () => {
  it("adds a pattern to history", () => {
    const h = createErrorHistory();
    learnPattern(h, "my_pattern", /custom_error_\d+/i);

    expect(h.learnedPatterns).toHaveLength(1);
    expect(h.learnedPatterns[0]!.name).toBe("my_pattern");
  });

  it("replaces existing pattern with same name", () => {
    const h = createErrorHistory();
    learnPattern(h, "p1", /old/i);
    learnPattern(h, "p1", /new/i);

    expect(h.learnedPatterns).toHaveLength(1);
    expect(h.learnedPatterns[0]!.pattern.source).toBe("new");
  });
});

describe("getLearnedPatterns", () => {
  it("returns all learned patterns", () => {
    const h = createErrorHistory();
    learnPattern(h, "a", /a/i);
    learnPattern(h, "b", /b/i);

    const patterns = getLearnedPatterns(h);
    expect(patterns).toHaveLength(2);
  });
});

describe("removeLearnedPattern", () => {
  it("removes a pattern by name", () => {
    const h = createErrorHistory();
    learnPattern(h, "to_remove", /x/i);
    learnPattern(h, "to_keep", /y/i);

    expect(removeLearnedPattern(h, "to_remove")).toBe(true);
    expect(h.learnedPatterns).toHaveLength(1);
    expect(h.learnedPatterns[0]!.name).toBe("to_keep");
  });

  it("returns false for non-existent name", () => {
    const h = createErrorHistory();
    expect(removeLearnedPattern(h, "nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enhanced classification — new error types
// ---------------------------------------------------------------------------

describe("new error type classification", () => {
  describe("content_filter", () => {
    it("classifies OpenAI content policy violation", () => {
      const result = classifyError(errorChunk("content_policy_violation"));
      expect(result.type).toBe("content_filter");
    });

    it("classifies Anthropic content_error", () => {
      const result = classifyError(errorChunk("content_error: request blocked"));
      expect(result.type).toBe("content_filter");
    });

    it("classifies Google safety block", () => {
      const result = classifyError(errorChunk("blocked by SAFETY filter"));
      expect(result.type).toBe("content_filter");
    });

    it("classifies generic content policy violation", () => {
      const result = classifyError(errorChunk("request violates usage policy"));
      expect(result.type).toBe("content_filter");
    });
  });

  describe("overloaded", () => {
    it("classifies Anthropic overloaded_error", () => {
      const result = classifyError(errorChunk("overloaded_error: API busy"));
      expect(result.type).toBe("overloaded");
    });

    it("classifies 529 status code", () => {
      const result = classifyError(errorChunk("status 529 server overloaded"));
      expect(result.type).toBe("overloaded");
    });

    it("classifies generic server overload", () => {
      const result = classifyError(errorChunk("server overload, try again later"));
      expect(result.type).toBe("overloaded");
    });
  });

  describe("model_not_found", () => {
    it("classifies model not found error", () => {
      const result = classifyError(errorChunk("model gpt-5 not found"));
      expect(result.type).toBe("model_not_found");
    });

    it("classifies unknown model error", () => {
      const result = classifyError(errorChunk("unknown model: test-model"));
      expect(result.type).toBe("model_not_found");
    });

    it("classifies 404 with model message", () => {
      const result = classifyError(errorChunk("status 404: model does not exist"));
      expect(result.type).toBe("model_not_found");
    });
  });

  describe("tool_error", () => {
    it("classifies tool_use_failed", () => {
      const result = classifyError(errorChunk("tool_use_failed: invalid args"));
      expect(result.type).toBe("tool_error");
    });

    it("classifies function_call_error", () => {
      const result = classifyError(errorChunk("function_call_error"));
      expect(result.type).toBe("tool_error");
    });

    it("classifies unknown tool", () => {
      const result = classifyError(errorChunk("unknown tool: search_web"));
      expect(result.type).toBe("tool_error");
    });
  });

  describe("request_too_large", () => {
    it("classifies payload too large", () => {
      const result = classifyError(errorChunk("payload too large for request"));
      expect(result.type).toBe("request_too_large");
    });

    it("classifies request body too large", () => {
      const result = classifyError(errorChunk("request body too large: 100MB"));
      expect(result.type).toBe("request_too_large");
    });
  });
});

// ---------------------------------------------------------------------------
// shouldRetry — new types
// ---------------------------------------------------------------------------

describe("shouldRetry for new error types", () => {
  it("does not retry content_filter", () => {
    const chunk = errorChunk("content_policy_violation");
    expect(shouldRetry(chunk)).toBe(false);
  });

  it("retries overloaded", () => {
    const chunk = errorChunk("overloaded_error");
    expect(shouldRetry(chunk)).toBe(true);
  });

  it("does not retry model_not_found", () => {
    const chunk = errorChunk("model not found");
    expect(shouldRetry(chunk)).toBe(false);
  });

  it("does not retry tool_error", () => {
    const chunk = errorChunk("tool_use_failed");
    expect(shouldRetry(chunk)).toBe(false);
  });

  it("does not retry request_too_large", () => {
    const chunk = errorChunk("payload too large");
    expect(shouldRetry(chunk)).toBe(false);
  });

  it("retriable flag overrides all defaults", () => {
    const chunk = errorChunk("content_policy_violation", undefined, true);
    expect(shouldRetry(chunk)).toBe(true);
  });
});
