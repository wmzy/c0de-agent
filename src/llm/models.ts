// Model capability registry (§4.5).
//
// A simple module-level Map keyed by model name. The provider layer reads
// capabilities to fill in ProviderConfig.models overrides and to compute
// costs via calculateCost().
//
// Prices reflect public list pricing as of mid-2026 — they are intentionally
// in USD per 1k tokens so callers can format / convert without unit math.

import type { ModelCapabilities } from "./types";
import { DEFAULT_MODEL_CAPABILITIES } from "./types";

const REGISTRY = new Map<string, ModelCapabilities>();

function register(model: string, caps: ModelCapabilities): void {
  REGISTRY.set(model.toLowerCase(), caps);
}

export function getModelCapabilities(model: string): ModelCapabilities {
  const caps = REGISTRY.get(model.toLowerCase());
  if (caps) return caps;
  // Fall back to provider-prefixed lookup (e.g. "openai/gpt-4o").
  const slash = model.lastIndexOf("/");
  if (slash >= 0) {
    const caps2 = REGISTRY.get(model.slice(slash + 1).toLowerCase());
    if (caps2) return caps2;
  }
  return DEFAULT_MODEL_CAPABILITIES;
}

export function registerModel(model: string, caps: ModelCapabilities): void {
  register(model, caps);
}

export function listRegisteredModels(): string[] {
  return Array.from(REGISTRY.keys());
}

// ---------------------------------------------------------------------------
// Pre-registered capabilities
// ---------------------------------------------------------------------------

// --- OpenAI ---------------------------------------------------------------
register("gpt-4o", {
  contextWindow: 128_000,
  maxOutput: 16_384,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: false,
  costPer1kInput: 0.0025,
  costPer1kOutput: 0.01,
});
register("gpt-4o-mini", {
  contextWindow: 128_000,
  maxOutput: 16_384,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: false,
  costPer1kInput: 0.00015,
  costPer1kOutput: 0.0006,
});
register("gpt-4.1", {
  contextWindow: 1_047_576,
  maxOutput: 32_768,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: false,
  costPer1kInput: 0.002,
  costPer1kOutput: 0.008,
});
register("gpt-4.1-mini", {
  contextWindow: 1_047_576,
  maxOutput: 32_768,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: false,
  costPer1kInput: 0.0004,
  costPer1kOutput: 0.0016,
});
register("gpt-4.1-nano", {
  contextWindow: 1_047_576,
  maxOutput: 32_768,
  supportsTools: true,
  supportsVision: false,
  supportsThinking: false,
  costPer1kInput: 0.0001,
  costPer1kOutput: 0.0004,
});
register("o3", {
  contextWindow: 200_000,
  maxOutput: 100_000,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: true,
  costPer1kInput: 0.01,
  costPer1kOutput: 0.04,
});
register("o4-mini", {
  contextWindow: 200_000,
  maxOutput: 100_000,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: true,
  costPer1kInput: 0.0011,
  costPer1kOutput: 0.0044,
});

// --- Anthropic ------------------------------------------------------------
register("claude-sonnet-4", {
  contextWindow: 200_000,
  maxOutput: 16_384,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: true,
  costPer1kInput: 0.003,
  costPer1kOutput: 0.015,
});
register("claude-opus-4", {
  contextWindow: 200_000,
  maxOutput: 32_768,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: true,
  costPer1kInput: 0.015,
  costPer1kOutput: 0.075,
});
register("claude-3-5-sonnet", {
  contextWindow: 200_000,
  maxOutput: 8_192,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: false,
  costPer1kInput: 0.003,
  costPer1kOutput: 0.015,
});
register("claude-3-5-haiku", {
  contextWindow: 200_000,
  maxOutput: 8_192,
  supportsTools: true,
  supportsVision: false,
  supportsThinking: false,
  costPer1kInput: 0.0008,
  costPer1kOutput: 0.004,
});

// --- Google ---------------------------------------------------------------
register("gemini-2.5-pro", {
  contextWindow: 1_000_000,
  maxOutput: 64_000,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: true,
  costPer1kInput: 0.00125,
  costPer1kOutput: 0.01,
});
register("gemini-2.5-flash", {
  contextWindow: 1_000_000,
  maxOutput: 64_000,
  supportsTools: true,
  supportsVision: true,
  supportsThinking: true,
  costPer1kInput: 0.0003,
  costPer1kOutput: 0.0025,
});

// --- OpenAI-compat: DeepSeek / Groq / Together / Mistral -----------------
register("deepseek-chat", {
  contextWindow: 64_000,
  maxOutput: 8_000,
  supportsTools: true,
  supportsVision: false,
  supportsThinking: false,
  costPer1kInput: 0.00027,
  costPer1kOutput: 0.0011,
});
register("deepseek-reasoner", {
  contextWindow: 64_000,
  maxOutput: 32_000,
  supportsTools: true,
  supportsVision: false,
  supportsThinking: true,
  costPer1kInput: 0.00055,
  costPer1kOutput: 0.00219,
});
register("llama-3.3-70b-versatile", {
  contextWindow: 131_072,
  maxOutput: 32_768,
  supportsTools: true,
  supportsVision: false,
  supportsThinking: false,
  costPer1kInput: 0.00059,
  costPer1kOutput: 0.00079,
});
register("mixtral-8x7b-32768", {
  contextWindow: 32_768,
  maxOutput: 4_000,
  supportsTools: true,
  supportsVision: false,
  supportsThinking: false,
  costPer1kInput: 0.00024,
  costPer1kOutput: 0.00024,
});
