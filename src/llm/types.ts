// LLM protocol-level types (§4 of the design spec).
//
// Ownership rule: this package owns the wire-shape types that the protocol
// implementations speak. Core owns the higher-level Message type and converts
// it to ChatMessage before calling chatStream.
//
// Conventions: data + functions only.
//   - All composite shapes use `type`, never `interface`.
//   - Variants are tagged via `_tag` and dispatched with switch on `_tag`.
//   - No class, no enum, no `this`.

// ---------------------------------------------------------------------------
// Structured content parts (§4.2 ChatMessage.content)
// ---------------------------------------------------------------------------

export type ContentPart =
  | { _tag: "text"; text: string }
  | { _tag: "image_url"; url: string; detail?: "auto" | "low" | "high" }
  | { _tag: "image_base64"; mediaType: string; data: string }
  | { _tag: "audio"; mediaType: string; data: string }
  | { _tag: "document"; mediaType: string; data: string; filename?: string };

// ---------------------------------------------------------------------------
// ChatMessage — the wire-format message passed to providers
// ---------------------------------------------------------------------------

export type ToolCallWire = {
  id: string;
  name: string;
  arguments: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  toolCallId?: string;
  toolCalls?: ToolCallWire[];
  /** Optional display name for tool messages (legacy OpenAI field). */
  name?: string;
};

// ---------------------------------------------------------------------------
// ChatTool — tool spec sent in a request
// ---------------------------------------------------------------------------

export type JSONSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export type ChatTool = {
  name: string;
  description: string;
  parameters: JSONSchema;
};

// ---------------------------------------------------------------------------
// ChatRequest — the full request shape protocol handlers consume
// ---------------------------------------------------------------------------

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  stream: true;
  maxTokens?: number;
  temperature?: number;
  system?: string;
  stop?: string[];
  topP?: number;
  /** When true, providers should keep system prompt + tool defs stable across turns. */
  preferCacheStable?: boolean;
};

// ---------------------------------------------------------------------------
// StreamChunk — protocol-neutral streaming event
// ---------------------------------------------------------------------------

export type StreamChunk =
  | { _tag: "text"; text: string }
  | { _tag: "tool_call"; id: string; name: string; args: string }
  | { _tag: "thinking"; text: string }
  | { _tag: "usage"; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { _tag: "done" }
  | { _tag: "error"; message: string; code?: string; retriable?: boolean };

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

export type ModelOverride = {
  contextWindow?: number;
  maxOutput?: number;
  costPer1kInput?: number;
  costPer1kOutput?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  /** If true, the model exposes an explicit `reasoning` / thinking channel. */
  reasoningChannel?: "openai_responses" | "anthropic_extended" | "google_thought" | "none";
};

export type ProviderConfig =
  | {
      _tag: "openai";
      apiKey: string;
      baseURL?: string;
      models?: Record<string, ModelOverride>;
      /** Use the Responses API instead of Chat Completions. */
      useResponses?: boolean;
    }
  | {
      _tag: "anthropic";
      apiKey: string;
      baseURL?: string;
      models?: Record<string, ModelOverride>;
    }
  | {
      _tag: "google";
      apiKey: string;
      baseURL?: string;
      models?: Record<string, ModelOverride>;
    }
  | {
      _tag: "openai-compat";
      apiKey: string;
      baseURL: string;
      /** Display name for this compat endpoint. */
      label?: string;
      models?: Record<string, ModelOverride>;
    };

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

export type Model = {
  name: string;
  provider: string;
  contextWindow: number;
  maxOutput: number;
  costPer1kInput: number;
  costPer1kOutput: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsThinking: boolean;
};

export type ModelCapabilities = {
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsThinking: boolean;
  costPer1kInput: number;
  costPer1kOutput: number;
};

export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  contextWindow: 128_000,
  maxOutput: 8_192,
  supportsTools: true,
  supportsVision: false,
  supportsThinking: false,
  costPer1kInput: 0,
  costPer1kOutput: 0,
};

// ---------------------------------------------------------------------------
// Model roles and routing (§4.6)
// ---------------------------------------------------------------------------

export type ModelRole =
  | { readonly _tag: "default" }
  | { readonly _tag: "smol" }
  | { readonly _tag: "slow" }
  | { readonly _tag: "plan" }
  | { readonly _tag: "commit" };

export type RoleBinding = { provider: string; model: string };

export type RoleRouting = Record<ModelRole["_tag"], RoleBinding>;

export const MODEL_ROLES: ReadonlyArray<ModelRole["_tag"]> = [
  "default",
  "smol",
  "slow",
  "plan",
  "commit",
];

// ---------------------------------------------------------------------------
// Fallback chains (§4.7)
// ---------------------------------------------------------------------------

/** Sort mode for dynamic fallback chain ordering. */
export type FallbackSortMode = "manual" | "cost" | "performance" | "balanced";

export type FallbackChain = {
  primary: string;
  fallbacks: string[];
  retryDelay: number;
  maxRetries: number;
  /** When set, the chain is dynamically reordered before use. */
  sortMode?: FallbackSortMode;
  /** Per-request cost ceiling in USD. Providers estimated to exceed this are skipped. */
  costBudgetUsd?: number;
  /** When true, performance-sorted chains weight latency more heavily. */
  preferLowLatency?: boolean;
};

// ---------------------------------------------------------------------------
// Runtime retry strategy (§4.7 — quota-aware retries)
// ---------------------------------------------------------------------------

/** Per-error-type retry strategy computed by `getRetryStrategy`. */
export type RetryStrategy = {
  shouldRetry: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  /** When set, the error is non-retriable and this is the human-readable reason. */
  abortReason?: string;
};

/**
 * Context passed to `chatStreamWithFallback` to control retry behavior.
 *
 * - `isSubAgent`: when true, quota errors abort immediately (prevents
 *   infinite retry cascades in nested agent trees).
 * - `label`: human-readable tag for structured retry logs.
 * - `onRetry`: optional callback invoked on every retry/fallback/abort
 *   decision so callers can collect structured logs programmatically.
 * - `runtime`: optional mutable chain state for dynamic provider health
 *   tracking. When provided, exhausted providers are skipped automatically.
 */
export type RetryContext = {
  isSubAgent: boolean;
  label: string;
  onRetry?: (entry: RetryLogEntry) => void;
  runtime?: FallbackChainRuntime;
  /** Provider metrics for cost/performance-aware chain ordering. */
  metricsMap?: Map<string, ProviderMetrics>;
};

/** One structured entry in the retry log. */
export type RetryLogEntry = {
  timestamp: number;
  provider: string;
  attempt: number;
  maxRetries: number;
  errorType: string;
  decision: "retry" | "fallback" | "abort" | "success" | "skip";
  delayMs: number;
  reason: string;
};

// ---------------------------------------------------------------------------
// Provider metrics for cost/performance-aware fallback (§4.7 enhanced)
// ---------------------------------------------------------------------------

/** Per-provider performance metrics accumulated across requests. */
export type ProviderMetrics = {
  provider: string;
  totalRequests: number;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  totalCostUsd: number;
  lastError?: string;
  lastErrorAt?: number;
};

/** Aggregated fallback statistics for reporting. */
export type FallbackStats = {
  totalRequests: number;
  fallbackTriggers: number;
  providerMetrics: Map<string, ProviderMetrics>;
  chainAdjustments: number;
  totalCostUsd: number;
  avgLatencyMs: number;
};

/** Serializable fallback chain configuration (JSON-safe). */
export type FallbackChainConfig = {
  primary: string;
  fallbacks: string[];
  retryDelay: number;
  maxRetries: number;
  sortMode: FallbackSortMode;
  costBudgetUsd?: number;
  preferLowLatency?: boolean;
};

// ---------------------------------------------------------------------------
// Provider health tracking for dynamic fallback (§4.7 enhanced)
// ---------------------------------------------------------------------------

/**
 * Runtime health state for a provider in the fallback chain.
 * Used by `adjustFallbackChain` to skip exhausted or cooling-down providers.
 */
export type ProviderHealthState =
  | { _tag: "healthy" }
  | { _tag: "quota_exhausted"; since: number; reason: string }
  | { _tag: "cooldown"; until: number; reason: string };

/**
 * Runtime state tracking provider health across the fallback chain.
 * Updated in-place during `chatStreamWithFallback` execution.
 */
export type FallbackChainRuntime = {
  /** Per-provider health. Absent = never tried, implicitly healthy. */
  health: Map<string, ProviderHealthState>;
  /** The ordered list of providers still considered for fallback. */
  activeChain: string[];
  /** Providers removed from the chain due to permanent exhaustion. */
  exhausted: string[];
  /** Total chain adjustments made during this run. */
  adjustments: number;
};

// ---------------------------------------------------------------------------
// Provider instance + registry
// ---------------------------------------------------------------------------

export type ProtocolHandler = {
  name: string;
  chat(request: ChatRequest, config: ProviderConfig): AsyncGenerator<StreamChunk>;
  listModels?(config: ProviderConfig): Promise<Model[]>;
};

export type ProviderInstance = {
  config: ProviderConfig;
  handler: ProtocolHandler;
};

export type ProviderRegistry = {
  providers: Map<string, ProviderInstance>;
  routing?: RoleRouting;
  fallback?: FallbackChain;
};

// ---------------------------------------------------------------------------
// Cache strategies (§4.8)
// ---------------------------------------------------------------------------

export type CacheStrategy = {
  provider: string;
  apply(request: ChatRequest): ChatRequest;
};

export type CacheRegistry = {
  strategies: Map<string, CacheStrategy>;
};

// ---------------------------------------------------------------------------
// Resolved model reference
// ---------------------------------------------------------------------------

export type ResolvedModel = {
  provider: string;
  model: string;
};
