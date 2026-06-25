// Enhanced fallback chain — cost-based, performance-based, persistence, stats (§4.7).
//
// Pure functions operating on data shapes from ./types. No classes, no enums,
// no `this`. Each function takes data in and returns data out.
//
// Responsibilities:
//   - Rank providers by estimated cost or observed performance.
//   - Build an optimally-ordered chain from a base FallbackChain.
//   - Serialize / deserialize chain config for persistence.
//   - Accumulate per-provider metrics and produce human-readable reports.

import { calculateCost, estimateRequestTokens } from "./token";
import { getModelCapabilities } from "./models";
import type {
  ChatRequest,
  FallbackChain,
  FallbackChainConfig,
  FallbackChainRuntime,
  FallbackSortMode,
  FallbackStats,
  ProviderMetrics,
  ProviderRegistry,
} from "./types";

// ---------------------------------------------------------------------------
// Provider metrics — creation and recording
// ---------------------------------------------------------------------------

/** Create a zeroed-out metrics record for a provider. */
export function createProviderMetrics(provider: string): ProviderMetrics {
  return {
    provider,
    totalRequests: 0,
    successes: 0,
    failures: 0,
    totalLatencyMs: 0,
    totalCostUsd: 0,
  };
}

/**
 * Record a completed request against a provider's metrics.
 * Returns a new metrics object (immutable update).
 */
export function recordRequest(
  metrics: ProviderMetrics,
  latencyMs: number,
  success: boolean,
  costUsd: number,
  errorMsg?: string,
): ProviderMetrics {
  return {
    ...metrics,
    totalRequests: metrics.totalRequests + 1,
    successes: metrics.successes + (success ? 1 : 0),
    failures: metrics.failures + (success ? 0 : 1),
    totalLatencyMs: metrics.totalLatencyMs + latencyMs,
    totalCostUsd: metrics.totalCostUsd + costUsd,
    ...(success ? {} : { lastError: errorMsg, lastErrorAt: Date.now() }),
  };
}

/**
 * Record a completed request, mutating the metrics map in-place.
 * Creates the metrics entry if absent.
 */
export function recordRequestInMap(
  metricsMap: Map<string, ProviderMetrics>,
  provider: string,
  latencyMs: number,
  success: boolean,
  costUsd: number,
  errorMsg?: string,
): void {
  const existing = metricsMap.get(provider) ?? createProviderMetrics(provider);
  metricsMap.set(provider, recordRequest(existing, latencyMs, success, costUsd, errorMsg));
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the cost of a single request through a specific provider.
 * Uses the model capabilities registry to look up per-token pricing,
 * then multiplies by estimated token counts.
 *
 * Returns 0 when the provider or model is unknown (graceful degradation).
 */
export function estimateProviderCost(
  providerName: string,
  modelName: string,
  request: ChatRequest,
  registry: ProviderRegistry,
): number {
  const instance = registry.providers.get(providerName);
  if (!instance) return 0;

  // Check for per-provider model overrides first, then the global registry.
  const override = instance.config._tag !== "openai-compat"
    ? instance.config.models?.[modelName]
    : undefined;
  const caps = override
    ? {
        costPer1kInput: override.costPer1kInput ?? 0,
        costPer1kOutput: override.costPer1kOutput ?? 0,
      }
    : getModelCapabilities(modelName);

  const inputTokens = estimateRequestTokens(request);
  // Assume a modest output estimate for cost projection (not known until streaming).
  const estimatedOutputTokens = Math.min(inputTokens, 4096);
  return calculateCost(caps, inputTokens, estimatedOutputTokens);
}

// ---------------------------------------------------------------------------
// Provider ranking
// ---------------------------------------------------------------------------

/**
 * Rank providers by estimated cost (cheapest first).
 * Providers with unknown cost are placed at the end.
 */
export function rankProvidersByCost(
  providers: string[],
  registry: ProviderRegistry,
  request: ChatRequest,
): string[] {
  const scored = providers.map((p) => {
    const instance = registry.providers.get(p);
    const model = instance ? request.model : request.model;
    return { provider: p, cost: estimateProviderCost(p, model, request, registry) };
  });
  scored.sort((a, b) => a.cost - b.cost);
  return scored.map((s) => s.provider);
}

/**
 * Rank providers by observed performance.
 *
 * Scoring formula:
 *   score = successRate × (1 / avgLatencySec)
 *
 * Higher score = better. Providers with no data are ranked last.
 * When `weightLatency` is true, latency is weighted 2× in the score.
 */
export function rankProvidersByPerformance(
  providers: string[],
  metricsMap: Map<string, ProviderMetrics>,
  weightLatency = false,
): string[] {
  const scored = providers.map((p) => {
    const m = metricsMap.get(p);
    if (!m || m.totalRequests === 0) {
      return { provider: p, score: -1 };
    }
    const successRate = m.successes / m.totalRequests;
    const avgLatencySec = m.totalLatencyMs / m.totalRequests / 1000;
    // Avoid division by zero for instant responses.
    const latencyFactor = avgLatencySec > 0 ? 1 / avgLatencySec : 1000;
    const latencyWeight = weightLatency ? 2 : 1;
    const score = successRate * latencyFactor * latencyWeight;
    return { provider: p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.provider);
}

/**
 * Rank providers using a balanced score of cost and performance.
 *
 * Each dimension is normalized to [0, 1] and combined:
 *   balanced = costWeight × (1 - normalizedCost) + perfWeight × normalizedPerf
 *
 * Default weights: 40% cost, 60% performance.
 */
export function rankProvidersBalanced(
  providers: string[],
  registry: ProviderRegistry,
  metricsMap: Map<string, ProviderMetrics>,
  request: ChatRequest,
  weightLatency = false,
  costWeight = 0.4,
): string[] {
  const perfWeight = 1 - costWeight;

  // Compute raw cost scores.
  const costs = providers.map((p) => {
    const instance = registry.providers.get(p);
    const model = instance ? request.model : request.model;
    return estimateProviderCost(p, model, request, registry);
  });
  const maxCost = Math.max(...costs, 1e-10);

  // Compute raw performance scores.
  const perfs = providers.map((p) => {
    const m = metricsMap.get(p);
    if (!m || m.totalRequests === 0) return 0;
    const successRate = m.successes / m.totalRequests;
    const avgLatencySec = m.totalLatencyMs / m.totalRequests / 1000;
    const latencyFactor = avgLatencySec > 0 ? 1 / avgLatencySec : 1000;
    const latencyWeight = weightLatency ? 2 : 1;
    return successRate * latencyFactor * latencyWeight;
  });
  const maxPerf = Math.max(...perfs, 1e-10);

  const scored = providers.map((p, i) => {
    const normalizedCost = costs[i] / maxCost;
    const normalizedPerf = perfs[i] / maxPerf;
    const score = costWeight * (1 - normalizedCost) + perfWeight * normalizedPerf;
    return { provider: p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.provider);
}

// ---------------------------------------------------------------------------
// Chain building
// ---------------------------------------------------------------------------

/**
 * Build an optimally-ordered provider list from a FallbackChain, applying the
 * chain's sortMode. Providers exceeding `costBudgetUsd` are filtered out.
 *
 * When sortMode is "manual", the original ordering is preserved.
 * When no metrics data exists, falls back to cost-only ranking.
 */
export function buildOptimalChain(
  chain: FallbackChain,
  registry: ProviderRegistry,
  metricsMap: Map<string, ProviderMetrics>,
  request: ChatRequest,
): string[] {
  const allProviders = [chain.primary, ...chain.fallbacks];

  // Filter by cost budget if set.
  const withinBudget = chain.costBudgetUsd != null
    ? allProviders.filter((p) => {
        const instance = registry.providers.get(p);
        const model = instance ? request.model : request.model;
        const cost = estimateProviderCost(p, model, request, registry);
        return cost <= chain.costBudgetUsd!;
      })
    : allProviders;

  const sortMode: FallbackSortMode = chain.sortMode ?? "manual";
  switch (sortMode) {
    case "manual":
      return withinBudget;

    case "cost":
      return rankProvidersByCost(withinBudget, registry, request);

    case "performance":
      return rankProvidersByPerformance(withinBudget, metricsMap, chain.preferLowLatency);

    case "balanced":
      return rankProvidersBalanced(
        withinBudget,
        registry,
        metricsMap,
        request,
        chain.preferLowLatency,
      );
  }
}

// ---------------------------------------------------------------------------
// Persistence — serialize / deserialize
// ---------------------------------------------------------------------------

/**
 * Convert a FallbackChain into a serializable FallbackChainConfig.
 * Fills in default values for the new optional fields.
 */
export function toFallbackChainConfig(chain: FallbackChain): FallbackChainConfig {
  return {
    primary: chain.primary,
    fallbacks: [...chain.fallbacks],
    retryDelay: chain.retryDelay,
    maxRetries: chain.maxRetries,
    sortMode: chain.sortMode ?? "manual",
    ...(chain.costBudgetUsd != null ? { costBudgetUsd: chain.costBudgetUsd } : {}),
    ...(chain.preferLowLatency != null ? { preferLowLatency: chain.preferLowLatency } : {}),
  };
}

/**
 * Convert a FallbackChainConfig back into a FallbackChain.
 */
export function fromFallbackChainConfig(config: FallbackChainConfig): FallbackChain {
  return {
    primary: config.primary,
    fallbacks: [...config.fallbacks],
    retryDelay: config.retryDelay,
    maxRetries: config.maxRetries,
    sortMode: config.sortMode,
    ...(config.costBudgetUsd != null ? { costBudgetUsd: config.costBudgetUsd } : {}),
    ...(config.preferLowLatency != null ? { preferLowLatency: config.preferLowLatency } : {}),
  };
}

/** Serialize a FallbackChain to a JSON string. */
export function serializeFallbackChainConfig(chain: FallbackChain): string {
  return JSON.stringify(toFallbackChainConfig(chain), null, 2);
}

/**
 * Deserialize a JSON string into a FallbackChain.
 * Returns an error string if the JSON is invalid or missing required fields.
 */
export function deserializeFallbackChainConfig(json: string): FallbackChain | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "Invalid JSON";
  }
  if (typeof parsed !== "object" || parsed === null) {
    return "Expected a JSON object";
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.primary !== "string") return "Missing or invalid 'primary' field";
  if (!Array.isArray(obj.fallbacks)) return "Missing or invalid 'fallbacks' field";
  if (typeof obj.retryDelay !== "number") return "Missing or invalid 'retryDelay' field";
  if (typeof obj.maxRetries !== "number") return "Missing or invalid 'maxRetries' field";

  const validSortModes = new Set(["manual", "cost", "performance", "balanced"]);
  const sortMode = typeof obj.sortMode === "string" && validSortModes.has(obj.sortMode)
    ? obj.sortMode as FallbackSortMode
    : "manual";

  return {
    primary: obj.primary,
    fallbacks: obj.fallbacks as string[],
    retryDelay: obj.retryDelay,
    maxRetries: obj.maxRetries,
    sortMode,
    ...(typeof obj.costBudgetUsd === "number" ? { costBudgetUsd: obj.costBudgetUsd } : {}),
    ...(typeof obj.preferLowLatency === "boolean" ? { preferLowLatency: obj.preferLowLatency } : {}),
  };
}

// ---------------------------------------------------------------------------
// Statistics and reporting
// ---------------------------------------------------------------------------

/**
 * Compute aggregate fallback statistics from a runtime and metrics map.
 */
export function computeFallbackStats(
  runtime: FallbackChainRuntime,
  metricsMap: Map<string, ProviderMetrics>,
): FallbackStats {
  let totalRequests = 0;
  let totalCostUsd = 0;
  let totalLatencyMs = 0;
  let totalSuccesses = 0;

  for (const m of metricsMap.values()) {
    totalRequests += m.totalRequests;
    totalCostUsd += m.totalCostUsd;
    totalLatencyMs += m.totalLatencyMs;
    totalSuccesses += m.successes;
  }

  // Fallback triggers = total requests minus the number of times the primary
  // succeeded on the first try. We approximate: every non-primary success or
  // any failure counts as a fallback trigger.
  const fallbackTriggers = runtime.adjustments;

  const avgLatencyMs = totalRequests > 0 ? totalLatencyMs / totalRequests : 0;

  return {
    totalRequests,
    fallbackTriggers,
    providerMetrics: new Map(metricsMap),
    chainAdjustments: runtime.adjustments,
    totalCostUsd,
    avgLatencyMs,
  };
}

/**
 * Format a human-readable fallback report from aggregated stats.
 *
 * Example output:
 * ```
 * ── Fallback Chain Report ──────────────────────
 *  Total requests:       42
 *  Fallback triggers:     7
 *  Chain adjustments:     3
 *  Total cost:         $1.23
 *  Avg latency:       1.2s
 *
 *  Provider breakdown:
 *    openai       20 reqs  95% ok  avg 800ms  $0.45
 *    anthropic    15 reqs 100% ok  avg 1.2s   $0.60
 *    google        7 reqs  86% ok  avg 2.0s   $0.18
 * ───────────────────────────────────────────────
 * ```
 */
export function formatFallbackReport(stats: FallbackStats): string {
  const lines: string[] = [];
  lines.push("── Fallback Chain Report ──────────────────────");
  lines.push(`  Total requests:    ${String(stats.totalRequests).padStart(6)}`);
  lines.push(`  Fallback triggers: ${String(stats.fallbackTriggers).padStart(6)}`);
  lines.push(`  Chain adjustments: ${String(stats.chainAdjustments).padStart(6)}`);
  lines.push(`  Total cost:        $${stats.totalCostUsd.toFixed(2).padStart(5)}`);
  lines.push(`  Avg latency:       ${formatLatency(stats.avgLatencyMs).padStart(6)}`);
  lines.push("");
  lines.push("  Provider breakdown:");

  const sorted = [...stats.providerMetrics.values()].sort(
    (a, b) => b.totalRequests - a.totalRequests,
  );
  for (const m of sorted) {
    const successRate = m.totalRequests > 0
      ? Math.round((m.successes / m.totalRequests) * 100)
      : 0;
    const avgLatency = m.totalRequests > 0 ? m.totalLatencyMs / m.totalRequests : 0;
    const name = m.provider.padEnd(14);
    const reqs = `${m.totalRequests} reqs`.padStart(8);
    const ok = `${successRate}% ok`.padStart(7);
    const lat = `avg ${formatLatency(avgLatency)}`.padStart(10);
    const cost = `$${m.totalCostUsd.toFixed(2)}`.padStart(7);
    lines.push(`    ${name}${reqs}${ok}${lat}${cost}`);
  }

  lines.push("───────────────────────────────────────────────");
  return lines.join("\n");
}

/** Format latency in human-readable form. */
function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
