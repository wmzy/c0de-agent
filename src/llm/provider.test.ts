// Tests for runtime fallback enhancement (§4.7).
//
// Covers:
//   - Quota error classification (quota_exceeded / quota_temporary / quota_unknown)
//   - Sub-agent quota abort (prevents infinite retry cascades)
//   - Dynamic fallback chain adjustment (skip exhausted providers)
//   - Fallback chain runtime state tracking
//   - Retry-After extraction from error messages
//   - Detailed fallback logging

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  classifyError,
  classifyQuotaSubType,
  extractRetryAfterMs,
  isQuotaExceeded,
  isQuotaTemporary,
  shouldAbortForSubAgent,
} from "./errors";

import {
  chatStreamWithFallback,
  computeRetryDelay,
  createFallbackChainRuntime,
  createProviderRegistry,
  getActiveProviders,
  getRetryStrategy,
  isProviderAvailable,
  markProviderCooldown,
  markProviderExhausted,
} from "./provider";

import type {
  FallbackChain,
  FallbackChainRuntime,
  ProviderConfig,
  ProviderRegistry,
  RetryContext,
  RetryLogEntry,
  StreamChunk,
} from "./types";

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

/** Collect all chunks from an async generator into an array. */
async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Create a mock provider that yields specific chunks. */
function mockHandler(
  name: string,
  chunks: StreamChunk[],
): { name: string; chat: ReturnType<typeof vi.fn> } {
  return {
    name,
    chat: vi.fn(async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    }),
  };
}

/** Create a registry with mock providers. */
function makeRegistry(
  providers: Array<{ name: string; chunks: StreamChunk[] }>,
): ProviderRegistry {
  const registry = createProviderRegistry([]);
  for (const { name, chunks } of providers) {
    const handler = mockHandler(name, chunks);
    registry.providers.set(name, {
      config: { _tag: "openai-compat", apiKey: "test", baseURL: "http://localhost" },
      handler: handler as any,
    });
  }
  return registry;
}

function makeChain(primary: string, fallbacks: string[] = []): FallbackChain {
  return { primary, fallbacks, retryDelay: 100, maxRetries: 2 };
}

// ---------------------------------------------------------------------------
// Error classification — quota sub-types
// ---------------------------------------------------------------------------

describe("classifyQuotaSubType", () => {
  it("classifies hard quota exhaustion", () => {
    expect(classifyQuotaSubType(errorChunk("quota exceeded"))).toBe("quota_exceeded");
    expect(classifyQuotaSubType(errorChunk("billing limit reached"))).toBe("quota_exceeded");
    expect(classifyQuotaSubType(errorChunk("out of credits"))).toBe("quota_exceeded");
    expect(classifyQuotaSubType(errorChunk("insufficient_quota", "insufficient_quota"))).toBe(
      "quota_exceeded",
    );
  });

  it("classifies temporary quota limits", () => {
    expect(classifyQuotaSubType(errorChunk("tokens per minute exceeded"))).toBe("quota_temporary");
    expect(classifyQuotaSubType(errorChunk("concurrent requests exceeded"))).toBe(
      "quota_temporary",
    );
    expect(classifyQuotaSubType(errorChunk("burst rate limit"))).toBe("quota_temporary");
  });

  it("classifies unknown quota as fallback", () => {
    expect(classifyQuotaSubType(errorChunk("some quota issue"))).toBe("quota_unknown");
    expect(classifyQuotaSubType(errorChunk("billing anomaly detected"))).toBe("quota_unknown");
  });
});

describe("classifyError", () => {
  it("classifies quota errors before auth errors", () => {
    // OpenAI returns 403 for insufficient_quota, which could be misclassified as auth
    const err = errorChunk("insufficient_quota", "insufficient_quota");
    const result = classifyError(err);
    expect(result.type).toBe("quota_exceeded");
  });

  it("classifies all three quota sub-types", () => {
    expect(classifyError(errorChunk("quota exceeded")).type).toBe("quota_exceeded");
    expect(classifyError(errorChunk("tokens per minute exceeded")).type).toBe("quota_temporary");
    expect(classifyError(errorChunk("some quota issue")).type).toBe("quota_unknown");
  });
});

// ---------------------------------------------------------------------------
// shouldAbortForSubAgent
// ---------------------------------------------------------------------------

describe("shouldAbortForSubAgent", () => {
  it("returns true for all quota error types", () => {
    expect(shouldAbortForSubAgent({ type: "quota_exceeded", message: "" })).toBe(true);
    expect(shouldAbortForSubAgent({ type: "quota_temporary", message: "" })).toBe(true);
    expect(shouldAbortForSubAgent({ type: "quota_unknown", message: "" })).toBe(true);
  });

  it("returns false for non-quota errors", () => {
    expect(shouldAbortForSubAgent({ type: "rate_limited", message: "" })).toBe(false);
    expect(shouldAbortForSubAgent({ type: "network_error", message: "" })).toBe(false);
    expect(shouldAbortForSubAgent({ type: "server_error", message: "" })).toBe(false);
    expect(shouldAbortForSubAgent({ type: "context_overflow", message: "" })).toBe(false);
    expect(shouldAbortForSubAgent({ type: "auth_error", message: "" })).toBe(false);
    expect(shouldAbortForSubAgent({ type: "unknown", message: "" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractRetryAfterMs
// ---------------------------------------------------------------------------

describe("extractRetryAfterMs", () => {
  it("parses retry-after: N header format", () => {
    expect(extractRetryAfterMs(errorChunk("rate limited, retry-after: 30"))).toBe(30_000);
    expect(extractRetryAfterMs(errorChunk("retry_after=60"))).toBe(60_000);
  });

  it("parses 'try again in N seconds' format", () => {
    expect(extractRetryAfterMs(errorChunk("please try again in 45 seconds"))).toBe(45_000);
    expect(extractRetryAfterMs(errorChunk("wait 10s"))).toBe(10_000);
  });

  it("returns undefined when no hint found", () => {
    expect(extractRetryAfterMs(errorChunk("something went wrong"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Retry strategy — sub-agent behavior
// ---------------------------------------------------------------------------

describe("getRetryStrategy", () => {
  it("quota_exceeded: never retry, even for main agent", () => {
    const strategy = getRetryStrategy({ type: "quota_exceeded", message: "" });
    expect(strategy.shouldRetry).toBe(false);
    expect(strategy.abortReason).toBeDefined();
  });

  it("quota_temporary: main agent retries with backoff", () => {
    const strategy = getRetryStrategy(
      { type: "quota_temporary", message: "" },
      { isSubAgent: false, label: "test" },
    );
    expect(strategy.shouldRetry).toBe(true);
    expect(strategy.maxRetries).toBeGreaterThan(0);
  });

  it("quota_temporary: sub-agent aborts immediately", () => {
    const strategy = getRetryStrategy(
      { type: "quota_temporary", message: "" },
      { isSubAgent: true, label: "test" },
    );
    expect(strategy.shouldRetry).toBe(false);
    expect(strategy.abortReason).toContain("Sub-agent");
  });

  it("quota_unknown: sub-agent aborts immediately", () => {
    const strategy = getRetryStrategy(
      { type: "quota_unknown", message: "" },
      { isSubAgent: true, label: "test" },
    );
    expect(strategy.shouldRetry).toBe(false);
    expect(strategy.abortReason).toContain("Sub-agent");
  });
});

// ---------------------------------------------------------------------------
// FallbackChainRuntime — provider health tracking
// ---------------------------------------------------------------------------

describe("FallbackChainRuntime", () => {
  let runtime: FallbackChainRuntime;

  beforeEach(() => {
    runtime = createFallbackChainRuntime();
  });

  it("creates empty runtime with empty maps", () => {
    expect(runtime.health.size).toBe(0);
    expect(runtime.activeChain).toEqual([]);
    expect(runtime.exhausted).toEqual([]);
    expect(runtime.adjustments).toBe(0);
  });

  it("marks provider as exhausted", () => {
    markProviderExhausted(runtime, "openai", "quota exceeded");
    expect(runtime.health.get("openai")?._tag).toBe("quota_exhausted");
    expect(runtime.exhausted).toContain("openai");
    expect(runtime.adjustments).toBe(1);
  });

  it("marks provider cooldown with expiry", () => {
    const until = Date.now() + 60_000;
    markProviderCooldown(runtime, "anthropic", until, "temp limit");
    const state = runtime.health.get("anthropic");
    expect(state?._tag).toBe("cooldown");
    if (state?._tag === "cooldown") {
      expect(state.until).toBe(until);
    }
  });

  it("isProviderAvailable returns true for unknown providers", () => {
    expect(isProviderAvailable(runtime, "openai")).toBe(true);
  });

  it("isProviderAvailable returns false for exhausted providers", () => {
    markProviderExhausted(runtime, "openai", "quota exceeded");
    expect(isProviderAvailable(runtime, "openai")).toBe(false);
  });

  it("isProviderAvailable returns false during active cooldown", () => {
    markProviderCooldown(runtime, "anthropic", Date.now() + 60_000, "temp limit");
    expect(isProviderAvailable(runtime, "anthropic")).toBe(false);
  });

  it("isProviderAvailable returns true after cooldown expires", () => {
    markProviderCooldown(runtime, "anthropic", Date.now() - 1000, "expired cooldown");
    expect(isProviderAvailable(runtime, "anthropic")).toBe(true);
  });

  it("getActiveProviders filters out exhausted providers", () => {
    const chain = makeChain("openai", ["anthropic", "google"]);
    markProviderExhausted(runtime, "openai", "quota exceeded");
    const active = getActiveProviders(runtime, chain);
    expect(active).toEqual(["anthropic", "google"]);
  });

  it("getActiveProviders initializes chain on first call", () => {
    const chain = makeChain("openai", ["anthropic"]);
    const active = getActiveProviders(runtime, chain);
    expect(active).toEqual(["openai", "anthropic"]);
    expect(runtime.activeChain).toEqual(["openai", "anthropic"]);
  });
});

// ---------------------------------------------------------------------------
// chatStreamWithFallback — dynamic chain adjustment
// ---------------------------------------------------------------------------

describe("chatStreamWithFallback", () => {
  it("falls back to next provider on provider-fatal error", async () => {
    const registry = makeRegistry([
      { name: "openai", chunks: [errorChunk("quota exceeded", "insufficient_quota")] },
      { name: "anthropic", chunks: [{ _tag: "text", text: "hello" }, { _tag: "done" }] },
    ]);
    const chain = makeChain("openai", ["anthropic"]);
    const runtime = createFallbackChainRuntime();
    const logs: RetryLogEntry[] = [];
    const context: RetryContext = {
      isSubAgent: false,
      label: "test",
      onRetry: (entry) => logs.push(entry),
      runtime,
    };

    const chunks = await collect(chatStreamWithFallback(registry, { model: "gpt-4", messages: [], stream: true }, chain, context));
    const texts = chunks.filter((c) => c._tag === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]._tag === "text" ? texts[0].text : "").toBe("hello");

    // Provider should be marked exhausted
    expect(runtime.exhausted).toContain("openai");

    // Should have logged the skip
    const skipLogs = logs.filter((l) => l.decision === "skip");
    expect(skipLogs.length).toBeGreaterThan(0);
  });

  it("sub-agent aborts on quota errors without retrying", async () => {
    const registry = makeRegistry([
      { name: "openai", chunks: [errorChunk("quota exceeded")] },
      { name: "anthropic", chunks: [{ _tag: "text", text: "should not reach" }, { _tag: "done" }] },
    ]);
    const chain = makeChain("openai", ["anthropic"]);
    const runtime = createFallbackChainRuntime();
    const logs: RetryLogEntry[] = [];
    const context: RetryContext = {
      isSubAgent: true,
      label: "sub-agent-test",
      onRetry: (entry) => logs.push(entry),
      runtime,
    };

    const chunks = await collect(chatStreamWithFallback(registry, { model: "gpt-4", messages: [], stream: true }, chain, context));
    const errors = chunks.filter((c) => c._tag === "error");
    expect(errors.length).toBeGreaterThan(0);

    // Anthropic should NOT have been called
    const anthropicInstance = registry.providers.get("anthropic")!;
    expect(anthropicInstance.handler.chat).not.toHaveBeenCalled();

    // Should have abort log
    const abortLogs = logs.filter((l) => l.decision === "abort");
    expect(abortLogs.length).toBeGreaterThan(0);
    expect(abortLogs[0].reason).toContain("Sub-agent");
  });

  it("skips exhausted providers in subsequent calls", async () => {
    const registry = makeRegistry([
      { name: "openai", chunks: [errorChunk("quota exceeded")] },
      { name: "anthropic", chunks: [{ _tag: "text", text: "ok" }, { _tag: "done" }] },
    ]);
    const chain = makeChain("openai", ["anthropic"]);
    const runtime = createFallbackChainRuntime();

    // First call exhausts openai, falls back to anthropic
    await collect(chatStreamWithFallback(registry, { model: "gpt-4", messages: [], stream: true }, chain, { isSubAgent: false, label: "test", runtime }));
    expect(runtime.exhausted).toContain("openai");

    // Second call should skip openai entirely
    const chunks2 = await collect(chatStreamWithFallback(registry, { model: "gpt-4", messages: [], stream: true }, chain, { isSubAgent: false, label: "test2", runtime }));
    const texts = chunks2.filter((c) => c._tag === "text");
    expect(texts).toHaveLength(1);

    // openai.chat should have been called only once (from the first call)
    const openaiInstance = registry.providers.get("openai")!;
    expect(openaiInstance.handler.chat).toHaveBeenCalledTimes(1);
  });

  it("yields error when all providers are exhausted", async () => {
    const registry = makeRegistry([
      { name: "openai", chunks: [errorChunk("quota exceeded")] },
      { name: "anthropic", chunks: [errorChunk("quota exceeded too")] },
    ]);
    const chain = makeChain("openai", ["anthropic"]);
    const runtime = createFallbackChainRuntime();
    const context: RetryContext = { isSubAgent: false, label: "test", runtime };

    const chunks = await collect(chatStreamWithFallback(registry, { model: "gpt-4", messages: [], stream: true }, chain, context));
    const errors = chunks.filter((c) => c._tag === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(runtime.exhausted).toContain("openai");
    expect(runtime.exhausted).toContain("anthropic");
  });

  it("handles empty provider chain gracefully", async () => {
    const registry = makeRegistry([]);
    const chain = makeChain("nonexistent", ["also-missing"]);
    const chunks = await collect(chatStreamWithFallback(registry, { model: "gpt-4", messages: [], stream: true }, chain));
    const errors = chunks.filter((c) => c._tag === "error");
    expect(errors.length).toBeGreaterThan(0);
    if (errors[0]._tag === "error") {
      expect(errors[0].code).toBe("fallback_empty");
    }
  });

  it("streams successful response directly when no errors", async () => {
    const registry = makeRegistry([
      { name: "openai", chunks: [{ _tag: "text", text: "hello" }, { _tag: "done" }] },
    ]);
    const chain = makeChain("openai");
    const chunks = await collect(chatStreamWithFallback(registry, { model: "gpt-4", messages: [], stream: true }, chain));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]._tag === "text" ? chunks[0].text : "").toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// computeRetryDelay
// ---------------------------------------------------------------------------

describe("computeRetryDelay", () => {
  it("computes exponential backoff capped at maxDelayMs", () => {
    const strategy = { shouldRetry: true, maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 10_000, backoffMultiplier: 2 };
    expect(computeRetryDelay(strategy, 0)).toBe(1000);
    expect(computeRetryDelay(strategy, 1)).toBe(2000);
    expect(computeRetryDelay(strategy, 2)).toBe(4000);
    expect(computeRetryDelay(strategy, 3)).toBe(8000);
    expect(computeRetryDelay(strategy, 4)).toBe(10_000); // capped
  });
});
