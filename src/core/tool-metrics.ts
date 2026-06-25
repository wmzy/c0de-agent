// §16.5 ModelToolMetrics — tool mode evaluation
//
// Runtime metrics for tracking tool performance across models and modes.
// Extracted from types.ts to separate runtime logic from type definitions.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelToolMetrics = {
  model: string;
  tool: string;
  mode: string;
  attempts: number;
  successes: number;
  failures: number;
  avgLatency: number;
  lastUsed: number;
};

// ---------------------------------------------------------------------------
// In-memory store + functions
// ---------------------------------------------------------------------------

const metricsStore: ModelToolMetrics[] = [];

export function recordToolResult(result: {
  model: string;
  tool: string;
  mode: string;
  success: boolean;
  latency: number;
}): void {
  const existing = metricsStore.find(
    (m) => m.model === result.model && m.tool === result.tool && m.mode === result.mode,
  );
  if (existing) {
    existing.attempts++;
    if (result.success) existing.successes++;
    else existing.failures++;
    existing.avgLatency =
      (existing.avgLatency * (existing.attempts - 1) + result.latency) / existing.attempts;
    existing.lastUsed = Date.now();
  } else {
    metricsStore.push({
      model: result.model,
      tool: result.tool,
      mode: result.mode,
      attempts: 1,
      successes: result.success ? 1 : 0,
      failures: result.success ? 0 : 1,
      avgLatency: result.latency,
      lastUsed: Date.now(),
    });
  }
}

export function selectBestMode(model: string, tool: string, defaultMode: string): string {
  const candidates = metricsStore.filter((m) => m.model === model && m.tool === tool);
  if (candidates.length === 0) return defaultMode;
  const best = candidates.find((m) => m.attempts >= 3 && m.successes / m.attempts > 0.8);
  return best ? best.mode : defaultMode;
}

export function getMetrics(model: string, tool: string): ModelToolMetrics[] {
  return metricsStore.filter((m) => m.model === model && m.tool === tool);
}
