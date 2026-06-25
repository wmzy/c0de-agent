// Error classification, aggregation, and analytics for LLM provider errors (§4.7).
//
// Provides comprehensive error detection using 40+ regex patterns across
// 14 error categories, borrowed from OpenCode's error classification and
// extended with provider-specific patterns for Cohere, AI21, Perplexity,
// Fireworks, and others.
//
// Additionally provides:
//   - Error aggregation and statistics (per-type, per-provider, per-model)
//   - Error trend analysis (sliding window, spike detection)
//   - Structured error reporting with recommendations
//   - Pattern matching diagnostics (which patterns matched an error)
//   - Runtime pattern learning (add custom patterns at runtime)
//
// Conventions: data + functions only.

import type { StreamChunk } from "./types";

// ---------------------------------------------------------------------------
// Error classification types (14 categories)
// ---------------------------------------------------------------------------

export type ErrorClassification =
  | { type: "context_overflow"; message: string }
  | { type: "rate_limited"; message: string }
  | { type: "quota_exceeded"; message: string }
  | { type: "quota_temporary"; message: string }
  | { type: "quota_unknown"; message: string }
  | { type: "auth_error"; message: string }
  | { type: "network_error"; message: string }
  | { type: "server_error"; message: string }
  | { type: "content_filter"; message: string }
  | { type: "overloaded"; message: string }
  | { type: "request_too_large"; message: string }
  | { type: "model_not_found"; message: string }
  | { type: "tool_error"; message: string }
  | { type: "unknown"; message: string };

/** Union of all error type discriminants. */
export type ErrorEventType = ErrorClassification["type"];

// ---------------------------------------------------------------------------
// Analytics types
// ---------------------------------------------------------------------------

/** Which patterns and error codes matched a given error. */
export type PatternMatchInfo = {
  errorType: ErrorClassification["type"];
  matchedPatterns: string[];
  matchedCodes: string[];
  learnedMatches: string[];
};

/** A single error occurrence with metadata. */
export type ErrorEvent = {
  timestamp: number;
  classification: ErrorClassification;
  provider?: string;
  model?: string;
  retriable: boolean;
  retryAfterMs?: number;
  patternMatch?: PatternMatchInfo;
};

/** Aggregate error counts. */
export type ErrorStats = {
  total: number;
  byType: Partial<Record<ErrorEventType, number>>;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  lastOccurrence: Partial<Record<ErrorEventType, number>>;
  averagePerMinute: Partial<Record<ErrorEventType, number>>;
};

/** One time window in a trend analysis. */
export type ErrorTrendWindow = {
  startMs: number;
  endMs: number;
  counts: Partial<Record<ErrorEventType, number>>;
  total: number;
};

/** Trend analysis result. */
export type ErrorTrend = {
  windows: ErrorTrendWindow[];
  direction: "increasing" | "decreasing" | "stable" | "insufficient_data";
  hotspots: Array<{ type: ErrorEventType; spikeRatio: number }>;
};

/** A learned custom pattern. */
export type LearnedPattern = {
  name: string;
  pattern: RegExp;
};

/** Mutable error history for aggregation and analytics. */
export type ErrorHistory = {
  events: ErrorEvent[];
  learnedPatterns: LearnedPattern[];
  maxEvents: number;
};

/** A single error occurrence in a report. */
export type ReportEntry = {
  classification: ErrorClassification;
  count: number;
  lastSeen: number;
  providers: string[];
};

/** Structured error report. */
export type ErrorReport = {
  generatedAt: number;
  period: { startMs: number; endMs: number };
  summary: ErrorStats;
  trends: ErrorTrend;
  topErrors: ReportEntry[];
  recommendations: string[];
};

// ---------------------------------------------------------------------------
// Context overflow detection (35+ patterns across providers)
// ---------------------------------------------------------------------------

/**
 * Regex patterns for detecting context window overflow across providers.
 * Each pattern targets a specific provider's error message format.
 */
const OVERFLOW_PATTERNS: readonly RegExp[] = [
  // Anthropic
  /prompt is too long/i,
  /prompt too long/i,
  // Amazon Bedrock
  /input is too long for requested model/i,
  // OpenAI (Completions + Responses API)
  /exceeds the context window/i,
  // Google (Gemini)
  /input token count.*exceeds the maximum/i,
  // xAI (Grok)
  /maximum prompt length is \d+/i,
  // Groq
  /reduce the length of the messages/i,
  // OpenRouter, DeepSeek, vLLM
  /maximum context length is \d+ tokens/i,
  // GitHub Copilot
  /exceeds the limit of \d+/i,
  // llama.cpp server
  /exceeds the available context size/i,
  // LM Studio
  /greater than the context length/i,
  // MiniMax
  /context window exceeds limit/i,
  // Kimi For Coding, Moonshot
  /exceeded model token limit/i,
  // Generic fallback (OpenAI, Anthropic, etc.)
  /context[_ ]length[_ ]exceeded/i,
  // HTTP 413
  /request entity too large/i,
  // vLLM specific
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  // Ollama explicit overflow
  /prompt too long; exceeded (?:max )?context length/i,
  // Mistral
  /too large for model with \d+ maximum context length/i,
  // z.ai non-standard finish_reason surfaced as error text
  /model_context_window_exceeded/i,
  // Additional provider patterns
  /token limit exceeded/i,
  /maximum tokens exceeded/i,
  /context window full/i,
  /input exceeds maximum/i,
  /messages.*too long/i,
  // Cerebras / Mistral no-body pattern
  /^4(00|13)\s*(status code)?\s*\(no body\)/i,
  // --- Extended patterns (Cohere, AI21, Perplexity, Fireworks, etc.) ---
  // Cohere
  /token count exceeds/i,
  // AI21 (Jurassic)
  /input is too long for model/i,
  // Fireworks AI
  /context length exceeded/i,
  // Perplexity
  /prompt is too long for/i,
  // Writer
  /input exceeds.*context/i,
  // AWS SageMaker
  /input size exceeds/i,
  // Azure OpenAI
  /maximum context length is exceeded/i,
  // Generic multi-provider
  /messages?.*exceed.*(?:limit|maximum|context)/i,
  /length.*(?:limit|maximum|window).*exceed/i,
  /sequence length.*exceed/i,
  // Anthropic batch API
  /prompt_too_long/i,
] as const;

// ---------------------------------------------------------------------------
// Error code / status classification sets
// ---------------------------------------------------------------------------

const OVERFLOW_ERROR_CODES: readonly string[] = [
  "context_length_exceeded",
  "context_window_exceeded",
  "max_tokens_exceeded",
  "prompt_too_long",
  "input_too_long",
];

const RATE_LIMIT_ERROR_CODES: readonly string[] = [
  "rate_limit_exceeded",
  "throttled",
  "too_many_requests",
  "rate_limit",
  "api_limit_exceeded",
  "token_rate_limit_exceeded",
];

const AUTH_ERROR_CODES: readonly string[] = [
  "invalid_api_key",
  "authentication_error",
  "permission_denied",
  "usage_not_included",
  "token_expired",
  "key_revoked",
  "access_denied",
  "invalid_credentials",
];

// Quota-related error codes — detected before auth to avoid misclassification.
const QUOTA_ERROR_CODES: readonly string[] = [
  "insufficient_quota",
  "quota_exceeded",
  "billing_hard_limit_reached",
  "usage_limit_reached",
];

// Temporary / burst quota codes.
const QUOTA_TEMPORARY_CODES: readonly string[] = [
  "concurrent_requests_exceeded",
  "burst_rate_limit",
  "tokens_per_minute_exceeded",
  "requests_per_minute_exceeded",
];

// ---------------------------------------------------------------------------
// New category: content filter patterns
// ---------------------------------------------------------------------------

const CONTENT_FILTER_PATTERNS: readonly RegExp[] = [
  // OpenAI
  /content_policy_violation/i,
  /the response was filtered/i,
  /content.*filter.*(?:block|reject|violation)/i,
  // Anthropic
  /content_error/i,
  /child_error/i,
  /content policy/i,
  /your request was rejected.*content/i,
  // Google (Gemini)
  /blocked.*safety/i,
  /finish_reason.*SAFETY/i,
  /recitation.*block/i,
  // Generic
  /violat.*(?:policy|guideline|terms)/i,
  /inappropriate.*content/i,
  /harmful.*content/i,
  /content.*moderat/i,
] as const;

const CONTENT_FILTER_ERROR_CODES: readonly string[] = [
  "content_policy_violation",
  "content_filter",
  "safety_error",
];

// ---------------------------------------------------------------------------
// New category: overloaded patterns (distinct from rate_limited)
// ---------------------------------------------------------------------------

const OVERLOADED_PATTERNS: readonly RegExp[] = [
  // OpenAI
  /server had an error processing/i,
  /server_error.*overload/i,
  // Anthropic
  /overloaded_error/i,
  /api is currently overloaded/i,
  // Google
  /UNAVAILABLE.*overload/i,
  /resource_exhausted.*overload/i,
  // Generic
  /server.*overload/i,
  /service.*overload/i,
  /capacity.*exceed/i,
  /system.*overload/i,
  /temporarily.*unavailable.*(?:overload|capacity)/i,
] as const;

const OVERLOADED_ERROR_CODES: readonly string[] = [
  "overloaded_error",
  "server_overloaded",
  "capacity_exceeded",
];

// ---------------------------------------------------------------------------
// New category: model not found patterns
// ---------------------------------------------------------------------------

const MODEL_NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /model.*not found/i,
  /model.*does not exist/i,
  /no such model/i,
  /unknown model/i,
  /model.*unavailable/i,
  /model.*not available/i,
  /model.*not supported/i,
  /invalid model/i,
  /model_id.*not found/i,
  /could not find model/i,
  /model.*deprecated/i,
  /no model.*with name/i,
] as const;

const MODEL_NOT_FOUND_ERROR_CODES: readonly string[] = [
  "model_not_found",
  "model_not_available",
  "model_deprecated",
  "invalid_model",
];

// ---------------------------------------------------------------------------
// New category: tool/function call error patterns
// ---------------------------------------------------------------------------

const TOOL_ERROR_PATTERNS: readonly RegExp[] = [
  /tool_use_failed/i,
  /function_call_error/i,
  /invalid tool_call/i,
  /tool.*error/i,
  /function.*error.*(?:invoke|call|exec)/i,
  /tool.*not found/i,
  /unknown tool/i,
  /invalid.*function.*argument/i,
  /tool.*timeout/i,
] as const;

const TOOL_ERROR_ERROR_CODES: readonly string[] = [
  "tool_use_failed",
  "function_call_error",
  "invalid_tool_call",
];

// ---------------------------------------------------------------------------
// New category: request too large patterns (distinct from context overflow)
// ---------------------------------------------------------------------------

const REQUEST_TOO_LARGE_PATTERNS: readonly RegExp[] = [
  /request body too large/i,
  /payload too large/i,
  /request.*size.*exceed/i,
  /body.*size.*limit/i,
  /request.*exceeds.*(?:size|limit|maximum)/i,
] as const;

// ---------------------------------------------------------------------------
// Network error patterns (expanded)
// ---------------------------------------------------------------------------

const NETWORK_PATTERNS: readonly RegExp[] = [
  /timeout/i,
  /etimedout/i,
  /socket hang up/i,
  /econnrefused/i,
  /econnreset/i,
  /econnaborted/i,
  /fetch failed/i,
  /enotfound/i,
  /eai_again/i,
  /ehostunreach/i,
  /enetunreach/i,
  /epipe/i,
  /network\s*(?:error|fail|unavailable)/i,
  /dns\s*(?:error|fail|resolution)/i,
  /tls\s*(?:error|fail)/i,
  /ssl\s*(?:error|fail)/i,
  /certificate\s*(?:error|fail|expired|invalid)/i,
  /connect(?:ion)?\s*(?:fail|error|refused|reset|timeout)/i,
] as const;

const NETWORK_ERROR_CODES: readonly string[] = [
  "network",
  "timeout",
  "enotfound",
  "eai_again",
  "ehostunreach",
  "enetunreach",
];

// ---------------------------------------------------------------------------
// Server error patterns (expanded for overloaded detection)
// ---------------------------------------------------------------------------

const SERVER_OVERLOADED_CODES: readonly string[] = [
  "http_529",
  "http_503",
];

// ---------------------------------------------------------------------------
// Quota error detection (§4.7 — quota-aware runtime fallback)
// ---------------------------------------------------------------------------

/**
 * Regex patterns for detecting quota/billing errors across providers.
 * Quota errors are split into three sub-types:
 *   - quota_exceeded:  hard billing limit — never retryable.
 *   - quota_temporary: burst / per-minute cap — retryable with long backoff.
 *   - quota_unknown:   generic quota mention — retry once cautiously.
 */
const QUOTA_EXCEEDED_PATTERNS: readonly RegExp[] = [
  /quota exceeded/i,
  /billing.*limit/i,
  /hard limit reached/i,
  /usage limit reached/i,
  /out of credits/i,
  /insufficient.*quota/i,
  /spending limit/i,
  /credit balance/i,
  /payment required/i,
  /plan.*limit.*reached/i,
  /monthly.*limit/i,
  /daily.*limit.*exceeded/i,
] as const;

const QUOTA_TEMPORARY_PATTERNS: readonly RegExp[] = [
  /concurrent.*request/i,
  /per.?minute.*(?:limit|quota|exceed)/i,
  /per.?second.*(?:limit|quota|exceed)/i,
  /tokens? per minute/i,
  /requests? per minute/i,
  /tpm.*(?:limit|exceed)/i,
  /rpm.*(?:limit|exceed)/i,
  /burst.*(?:limit|rate)/i,
  /temporarily.*(?:limit|quota|throttl)/i,
  /rate.*exceeded/i,
  /please.*(?:wait|retry).*after/i,
  /retry.?after/i,
] as const;

const QUOTA_GENERIC_PATTERNS: readonly RegExp[] = [
  /quota/i,
  /billing/i,
  /usage.*limit/i,
  /credit/i,
] as const;

// ---------------------------------------------------------------------------
// Helper: find matching pattern sources
// ---------------------------------------------------------------------------

function findMatchingPatterns(message: string, patterns: readonly RegExp[]): string[] {
  return patterns.filter((p) => p.test(message)).map((p) => p.source);
}

// ---------------------------------------------------------------------------
// Core detection functions
// ---------------------------------------------------------------------------

/** Check if an error is a context window overflow. */
export function isContextOverflow(error: StreamChunk & { _tag: "error" }): boolean {
  // 1. Check explicit error code
  if (error.code) {
    if (OVERFLOW_ERROR_CODES.includes(error.code)) return true;
    if (error.code === "http_413") return true;
    // Some providers use 400 for context overflow — check message patterns
    if (error.code === "http_400") {
      return OVERFLOW_PATTERNS.some((p) => p.test(error.message));
    }
  }

  // 2. Check HTTP status code in message text
  const statusMatch = error.message.match(/status[:\s]+(\d{3})/i);
  if (statusMatch) {
    const status = Number.parseInt(statusMatch[1], 10);
    if (status === 413) return true;
    if (status === 400) {
      return OVERFLOW_PATTERNS.some((p) => p.test(error.message));
    }
  }

  // 3. Check message against all regex patterns
  return OVERFLOW_PATTERNS.some((p) => p.test(error.message));
}

/** Check if an error is a rate limit (429 / throttle). */
export function isRateLimited(error: StreamChunk & { _tag: "error" }): boolean {
  if (error.code) {
    if (error.code === "http_429") return true;
    if (RATE_LIMIT_ERROR_CODES.includes(error.code)) return true;
  }

  const statusMatch = error.message.match(/status[:\s]+(\d{3})/i);
  if (statusMatch && Number.parseInt(statusMatch[1], 10) === 429) return true;

  const msg = error.message.toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("throttl") ||
    msg.includes("quota exceeded")
  );
}

/** Check if an error is an authentication / authorization failure. */
export function isAuthError(error: StreamChunk & { _tag: "error" }): boolean {
  if (error.code) {
    if (AUTH_ERROR_CODES.includes(error.code)) return true;
    if (error.code === "http_401" || error.code === "http_403") return true;
  }

  const statusMatch = error.message.match(/status[:\s]+(\d{3})/i);
  if (statusMatch) {
    const status = Number.parseInt(statusMatch[1], 10);
    if (status === 401 || status === 403) return true;
  }

  const msg = error.message.toLowerCase();
  return (
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("invalid api key") ||
    msg.includes("authentication") ||
    msg.includes("permission denied")
  );
}

/** Check if an error is a network-level failure (timeout, reset, etc.). */
export function isNetworkError(error: StreamChunk & { _tag: "error" }): boolean {
  if (error.code && NETWORK_ERROR_CODES.includes(error.code)) return true;

  return NETWORK_PATTERNS.some((p) => p.test(error.message));
}

/** Check if an error is a content policy / safety filter violation. */
export function isContentFilter(error: StreamChunk & { _tag: "error" }): boolean {
  if (error.code && CONTENT_FILTER_ERROR_CODES.includes(error.code)) return true;

  // Don't match on HTTP status alone — content filters can surface as 400 or 200.
  return CONTENT_FILTER_PATTERNS.some((p) => p.test(error.message));
}

/** Check if an error indicates the provider is overloaded (distinct from rate_limited). */
export function isOverloaded(error: StreamChunk & { _tag: "error" }): boolean {
  if (error.code) {
    if (OVERLOADED_ERROR_CODES.includes(error.code)) return true;
    if (SERVER_OVERLOADED_CODES.includes(error.code)) return true;
  }

  return OVERLOADED_PATTERNS.some((p) => p.test(error.message));
}

/** Check if an error indicates the requested model was not found. */
export function isModelNotFound(error: StreamChunk & { _tag: "error" }): boolean {
  if (error.code && MODEL_NOT_FOUND_ERROR_CODES.includes(error.code)) return true;

  // HTTP 404 with model-related message
  if (error.code === "http_404") {
    return MODEL_NOT_FOUND_PATTERNS.some((p) => p.test(error.message));
  }

  const statusMatch = error.message.match(/status[:\s]+(\d{3})/i);
  if (statusMatch && Number.parseInt(statusMatch[1], 10) === 404) {
    return MODEL_NOT_FOUND_PATTERNS.some((p) => p.test(error.message));
  }

  return MODEL_NOT_FOUND_PATTERNS.some((p) => p.test(error.message));
}

/** Check if an error is a tool/function call error. */
export function isToolError(error: StreamChunk & { _tag: "error" }): boolean {
  if (error.code && TOOL_ERROR_ERROR_CODES.includes(error.code)) return true;

  return TOOL_ERROR_PATTERNS.some((p) => p.test(error.message));
}

/** Check if an error is a request payload too large (distinct from context overflow). */
export function isRequestTooLarge(error: StreamChunk & { _tag: "error" }): boolean {
  // HTTP 400 or 413 with payload size messages
  if (error.code === "http_400" || error.code === "http_413") {
    return REQUEST_TOO_LARGE_PATTERNS.some((p) => p.test(error.message));
  }

  return REQUEST_TOO_LARGE_PATTERNS.some((p) => p.test(error.message));
}

/** Check if an error is a 5xx server error. */
export function isServerError(error: StreamChunk & { _tag: "error" }): boolean {
  // Overloaded errors (529, 503 with overload message) are NOT server errors.
  if (isOverloaded(error)) return false;

  if (error.code && error.code.startsWith("http_5")) return true;

  const statusMatch = error.message.match(/status[:\s]+(\d{3})/i);
  if (statusMatch) {
    const status = Number.parseInt(statusMatch[1], 10);
    if (status >= 500 && status < 600) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Quota error detection
// ---------------------------------------------------------------------------

/** Check if an error is a hard quota exhaustion (not retryable). */
export function isQuotaExceeded(error: StreamChunk & { _tag: "error" }): boolean {
  if (error.code && QUOTA_ERROR_CODES.includes(error.code)) return true;
  if (error.code === "http_429") {
    // 429 can be either rate-limit or quota; check message for quota signals.
    return QUOTA_EXCEEDED_PATTERNS.some((p) => p.test(error.message));
  }
  return QUOTA_EXCEEDED_PATTERNS.some((p) => p.test(error.message));
}

/** Check if an error is a temporary/burst quota limit (retryable with long backoff). */
export function isQuotaTemporary(error: StreamChunk & { _tag: "error" }): boolean {
  if (error.code && QUOTA_TEMPORARY_CODES.includes(error.code)) return true;
  return QUOTA_TEMPORARY_PATTERNS.some((p) => p.test(error.message));
}

/** Check if an error mentions quota at all (generic catch-all). */
function isQuotaMentioned(error: StreamChunk & { _tag: "error" }): boolean {
  if (
    error.code &&
    (QUOTA_ERROR_CODES.includes(error.code) || QUOTA_TEMPORARY_CODES.includes(error.code))
  ) {
    return true;
  }
  return (
    QUOTA_GENERIC_PATTERNS.some((p) => p.test(error.message)) ||
    QUOTA_TEMPORARY_PATTERNS.some((p) => p.test(error.message))
  );
}

/**
 * Classify a quota error into its sub-type.
 * Call only after confirming `isQuotaMentioned` is true.
 */
export function classifyQuotaSubType(
  error: StreamChunk & { _tag: "error" },
): "quota_exceeded" | "quota_temporary" | "quota_unknown" {
  if (isQuotaExceeded(error)) return "quota_exceeded";
  if (isQuotaTemporary(error)) return "quota_temporary";
  return "quota_unknown";
}

// ---------------------------------------------------------------------------
// Pattern matching diagnostics
// ---------------------------------------------------------------------------

/**
 * Identify which built-in and learned patterns matched a given error.
 * Useful for debugging classification and validating pattern learning.
 */
export function getPatternMatches(
  error: StreamChunk & { _tag: "error" },
  history?: ErrorHistory,
): PatternMatchInfo {
  const msg = error.message;
  const matchedPatterns: string[] = [];
  const matchedCodes: string[] = [];
  const learnedMatches: string[] = [];

  // Collect matching pattern sources from all categories
  matchedPatterns.push(...findMatchingPatterns(msg, OVERFLOW_PATTERNS));
  matchedPatterns.push(...findMatchingPatterns(msg, QUOTA_EXCEEDED_PATTERNS));
  matchedPatterns.push(...findMatchingPatterns(msg, QUOTA_TEMPORARY_PATTERNS));
  matchedPatterns.push(...findMatchingPatterns(msg, QUOTA_GENERIC_PATTERNS));
  matchedPatterns.push(...findMatchingPatterns(msg, CONTENT_FILTER_PATTERNS));
  matchedPatterns.push(...findMatchingPatterns(msg, OVERLOADED_PATTERNS));
  matchedPatterns.push(...findMatchingPatterns(msg, MODEL_NOT_FOUND_PATTERNS));
  matchedPatterns.push(...findMatchingPatterns(msg, TOOL_ERROR_PATTERNS));
  matchedPatterns.push(...findMatchingPatterns(msg, REQUEST_TOO_LARGE_PATTERNS));
  matchedPatterns.push(...findMatchingPatterns(msg, NETWORK_PATTERNS));

  // Collect matching error codes
  if (error.code) {
    const allCodes = [
      ...OVERFLOW_ERROR_CODES,
      ...RATE_LIMIT_ERROR_CODES,
      ...AUTH_ERROR_CODES,
      ...QUOTA_ERROR_CODES,
      ...QUOTA_TEMPORARY_CODES,
      ...CONTENT_FILTER_ERROR_CODES,
      ...OVERLOADED_ERROR_CODES,
      ...MODEL_NOT_FOUND_ERROR_CODES,
      ...TOOL_ERROR_ERROR_CODES,
      ...NETWORK_ERROR_CODES,
      ...SERVER_OVERLOADED_CODES,
    ];
    if (allCodes.includes(error.code)) {
      matchedCodes.push(error.code);
    }
  }

  // Check learned patterns
  if (history) {
    for (const lp of history.learnedPatterns) {
      if (lp.pattern.test(msg)) {
        learnedMatches.push(lp.name);
      }
    }
  }

  return {
    errorType: classifyError(error).type,
    matchedPatterns,
    matchedCodes,
    learnedMatches,
  };
}

// ---------------------------------------------------------------------------
// Full classification
// ---------------------------------------------------------------------------

/** Classify an error into one of the defined categories. */
export function classifyError(error: StreamChunk & { _tag: "error" }): ErrorClassification {
  const message = error.message;

  // Context overflow runs first — it's the most specific and critical.
  if (isContextOverflow(error)) {
    return { type: "context_overflow", message };
  }

  // Quota detection runs before auth because some providers (OpenAI)
  // return 403 for `insufficient_quota` which would otherwise match
  // the auth-error heuristics.
  if (isQuotaMentioned(error)) {
    return { type: classifyQuotaSubType(error), message };
  }

  // Content filter before rate-limited — some providers return 200 with
  // a content filter response that could be misidentified.
  if (isContentFilter(error)) {
    return { type: "content_filter", message };
  }

  if (isRateLimited(error)) {
    return { type: "rate_limited", message };
  }

  if (isAuthError(error)) {
    return { type: "auth_error", message };
  }

  // Model not found before server error — 404 responses would otherwise
  // be caught by generic HTTP status checks.
  if (isModelNotFound(error)) {
    return { type: "model_not_found", message };
  }

  // Overloaded before generic server error — 503/529 with overload signals
  // need distinct retry behavior (longer backoff than generic 5xx).
  if (isOverloaded(error)) {
    return { type: "overloaded", message };
  }

  if (isNetworkError(error)) {
    return { type: "network_error", message };
  }

  if (isServerError(error)) {
    return { type: "server_error", message };
  }

  // Tool errors and request-too-large are checked last as they are more
  // specific and less common.
  if (isToolError(error)) {
    return { type: "tool_error", message };
  }

  if (isRequestTooLarge(error)) {
    return { type: "request_too_large", message };
  }

  return { type: "unknown", message };
}

// ---------------------------------------------------------------------------
// Retry decision
// ---------------------------------------------------------------------------

/**
 * Determine whether an error should trigger a retry.
 *
 * Context overflow → never retry (needs compaction/trimming).
 * Quota exceeded → never retry (hard billing limit).
 * Quota temporary → retry with long backoff (burst cap).
 * Quota unknown → retry once cautiously.
 * Rate limiting → retry with backoff.
 * Auth errors → never retry (wrong credentials).
 * Network errors → retry (transient).
 * Server errors → retry (transient).
 * Content filter → never retry (policy violation).
 * Overloaded → retry with long backoff (transient capacity issue).
 * Model not found → never retry (wrong model name).
 * Tool error → never retry (needs fix to tool definition).
 * Request too large → never retry (needs smaller payload).
 * Unknown → fail-closed (no retry).
 */
export function shouldRetry(error: StreamChunk & { _tag: "error" }): boolean {
  // Explicit retriable flag takes precedence over all heuristics.
  if (error.retriable !== undefined) return error.retriable;

  switch (classifyError(error).type) {
    case "context_overflow":
      return false;
    case "quota_exceeded":
      return false;
    case "quota_temporary":
      return true;
    case "quota_unknown":
      return true;
    case "rate_limited":
      return true;
    case "auth_error":
      return false;
    case "network_error":
      return true;
    case "server_error":
      return true;
    case "content_filter":
      return false;
    case "overloaded":
      return true;
    case "model_not_found":
      return false;
    case "tool_error":
      return false;
    case "request_too_large":
      return false;
    case "unknown":
      return false;
  }
}

// ---------------------------------------------------------------------------
// Sub-agent abort predicate (§4.7 — prevents infinite retry cascades)
// ---------------------------------------------------------------------------

/**
 * Determine whether a sub-agent should abort immediately on this error.
 * Sub-agents abort on ALL quota errors (exhausted, temporary, unknown)
 * to prevent infinite retry cascades in nested agent trees.
 */
export function shouldAbortForSubAgent(
  classification: ErrorClassification,
): boolean {
  switch (classification.type) {
    case "quota_exceeded":
    case "quota_temporary":
    case "quota_unknown":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Retry-After extraction (§4.7 — parses server-provided delay hints)
// ---------------------------------------------------------------------------

/**
 * Extract a Retry-After delay from an error message or code.
 * Returns the delay in milliseconds, or `undefined` if no hint is found.
 *
 * Patterns matched:
 *   - `retry-after: 30` / `retry_after=30` (seconds)
 *   - `please retry after 2024-01-01T00:00:00Z` (ISO timestamp)
 *   - `try again in 60 seconds`
 *   - `wait 45s` / `wait 45 seconds`
 *   - `backoff: 120` (seconds)
 */
export function extractRetryAfterMs(
  error: StreamChunk & { _tag: "error" },
): number | undefined {
  const msg = error.message;

  // retry-after: <seconds>
  const secMatch = msg.match(/retry[_-]?after[:=\s]+(\d+)/i);
  if (secMatch) {
    return Number.parseInt(secMatch[1], 10) * 1000;
  }

  // ISO timestamp after "retry after"
  const tsMatch = msg.match(/retry\s+after\s+(\d{4}-\d{2}-\d{2}T[^\s]+)/i);
  if (tsMatch) {
    const target = new Date(tsMatch[1]).getTime();
    if (!Number.isNaN(target)) {
      return Math.max(0, target - Date.now());
    }
  }

  // "try again in N seconds" / "wait Ns"
  const waitMatch = msg.match(/(?:try\s+again\s+in|wait)\s+(\d+)\s*s(?:econds?)?/i);
  if (waitMatch) {
    return Number.parseInt(waitMatch[1], 10) * 1000;
  }

  // "backoff: N" / "backoff=N"
  const backoffMatch = msg.match(/backoff[:=\s]+(\d+)/i);
  if (backoffMatch) {
    return Number.parseInt(backoffMatch[1], 10) * 1000;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Error history management
// ---------------------------------------------------------------------------

/** Default maximum number of events to retain in history. */
const DEFAULT_MAX_EVENTS = 10_000;

/** Create an empty error history. */
export function createErrorHistory(maxEvents = DEFAULT_MAX_EVENTS): ErrorHistory {
  return {
    events: [],
    learnedPatterns: [],
    maxEvents,
  };
}

/**
 * Record an error event in the history.
 * Automatically prunes old events when the history exceeds `maxEvents`.
 */
export function recordError(
  history: ErrorHistory,
  error: StreamChunk & { _tag: "error" },
  provider?: string,
  model?: string,
  patternMatch?: PatternMatchInfo,
): ErrorEvent {
  const classification = classifyError(error);
  const event: ErrorEvent = {
    timestamp: Date.now(),
    classification,
    provider,
    model,
    retriable: error.retriable ?? shouldRetry(error),
    retryAfterMs: extractRetryAfterMs(error),
    patternMatch,
  };

  history.events.push(event);
  pruneHistory(history);

  return event;
}

/**
 * Prune events older than the max age or exceeding the max count.
 * Keeps the most recent events within both bounds.
 */
export function pruneHistory(history: ErrorHistory, maxAgeMs?: number): void {
  // Remove events older than maxAgeMs
  if (maxAgeMs !== undefined) {
    const cutoff = Date.now() - maxAgeMs;
    while (history.events.length > 0 && history.events[0]!.timestamp < cutoff) {
      history.events.shift();
    }
  }

  // Trim to maxEvents (keep newest)
  while (history.events.length > history.maxEvents) {
    history.events.shift();
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Compute aggregate error statistics from history.
 * Optionally filter to a time window (most recent `windowMs` milliseconds).
 */
export function getErrorStats(
  history: ErrorHistory,
  windowMs?: number,
): ErrorStats {
  const now = Date.now();
  const events = windowMs
    ? history.events.filter((e) => now - e.timestamp <= windowMs)
    : history.events;

  const byType: Partial<Record<ErrorEventType, number>> = {};
  const byProvider: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const lastOccurrence: Partial<Record<ErrorEventType, number>> = {};

  for (const event of events) {
    const t = event.classification.type;
    byType[t] = (byType[t] ?? 0) + 1;

    if (event.provider) {
      byProvider[event.provider] = (byProvider[event.provider] ?? 0) + 1;
    }
    if (event.model) {
      byModel[event.model] = (byModel[event.model] ?? 0) + 1;
    }

    const last = lastOccurrence[t] ?? 0;
    if (event.timestamp > last) {
      lastOccurrence[t] = event.timestamp;
    }
  }

  // Compute average per minute based on the time span of the window
  const spanMs =
    events.length > 1 ? events[events.length - 1]!.timestamp - events[0]!.timestamp : 60_000;
  const spanMinutes = Math.max(spanMs / 60_000, 1 / 60); // floor at 1 second

  const averagePerMinute: Partial<Record<ErrorEventType, number>> = {};
  for (const [type, count] of Object.entries(byType)) {
    averagePerMinute[type as ErrorEventType] = (count as number) / spanMinutes;
  }

  return {
    total: events.length,
    byType,
    byProvider,
    byModel,
    lastOccurrence,
    averagePerMinute,
  };
}

// ---------------------------------------------------------------------------
// Trend analysis
// ---------------------------------------------------------------------------

/**
 * Compute a simple linear regression slope over a numeric array.
 * Returns the slope (change per index unit).
 */
function computeSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumX2 += i * i;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}

/**
 * Analyze error trends over sliding time windows.
 *
 * @param history - The error history to analyze.
 * @param windowSizeMs - Duration of each window in milliseconds (default: 5 min).
 * @param windowCount - Number of windows to analyze (default: 6).
 */
export function analyzeTrends(
  history: ErrorHistory,
  windowSizeMs = 5 * 60_000,
  windowCount = 6,
): ErrorTrend {
  const now = Date.now();
  const windows: ErrorTrendWindow[] = [];

  for (let i = windowCount - 1; i >= 0; i--) {
    const startMs = now - (i + 1) * windowSizeMs;
    const endMs = now - i * windowSizeMs;
    const events = history.events.filter(
      (e) => e.timestamp >= startMs && e.timestamp < endMs,
    );

    const counts: Partial<Record<ErrorEventType, number>> = {};
    for (const event of events) {
      const t = event.classification.type;
      counts[t] = (counts[t] ?? 0) + 1;
    }

    windows.push({
      startMs,
      endMs,
      counts,
      total: events.length,
    });
  }

  // Determine trend direction from total counts across windows
  const totals = windows.map((w) => w.total);
  const slope = computeSlope(totals);
  const avgTotal = totals.reduce((a, b) => a + b, 0) / Math.max(totals.length, 1);

  let direction: ErrorTrend["direction"];
  if (avgTotal === 0 && totals.every((t) => t === 0)) {
    direction = "stable";
  } else if (totals.filter((t) => t > 0).length < 2) {
    direction = "insufficient_data";
  } else if (slope > avgTotal * 0.1) {
    direction = "increasing";
  } else if (slope < -avgTotal * 0.1) {
    direction = "decreasing";
  } else {
    direction = "stable";
  }

  // Detect hotspots: error types with a spike in recent windows vs earlier ones
  const hotspots = computeHotspots(windows);

  return { windows, direction, hotspots };
}

/**
 * Compute hotspots: error types that spiked recently compared to earlier windows.
 */
function computeHotspots(windows: ErrorTrendWindow[]): ErrorTrend["hotspots"] {
  if (windows.length < 2) return [];

  const mid = Math.floor(windows.length / 2);
  const recentWindows = windows.slice(mid);
  const earlierWindows = windows.slice(0, mid);

  // Aggregate counts per type in each half
  const recentCounts: Partial<Record<ErrorEventType, number>> = {};
  const earlierCounts: Partial<Record<ErrorEventType, number>> = {};

  for (const w of recentWindows) {
    for (const [type, count] of Object.entries(w.counts)) {
      recentCounts[type as ErrorEventType] =
        (recentCounts[type as ErrorEventType] ?? 0) + (count as number);
    }
  }
  for (const w of earlierWindows) {
    for (const [type, count] of Object.entries(w.counts)) {
      earlierCounts[type as ErrorEventType] =
        (earlierCounts[type as ErrorEventType] ?? 0) + (count as number);
    }
  }

  const hotspots: ErrorTrend["hotspots"] = [];

  for (const type of Object.keys(recentCounts) as ErrorEventType[]) {
    const recent = recentCounts[type] ?? 0;
    const earlier = earlierCounts[type] ?? 0;

    if (recent > 0) {
      const spikeRatio = earlier > 0 ? recent / earlier : recent; // if no earlier data, ratio = count
      if (spikeRatio > 2) {
        hotspots.push({ type, spikeRatio });
      }
    }
  }

  return hotspots.sort((a, b) => b.spikeRatio - a.spikeRatio);
}

// ---------------------------------------------------------------------------
// Error reporting
// ---------------------------------------------------------------------------

/**
 * Generate a structured error report with statistics, trends, and
 * actionable recommendations.
 *
 * @param history - The error history.
 * @param periodMs - Period to analyze in milliseconds (default: 30 min).
 */
export function generateErrorReport(
  history: ErrorHistory,
  periodMs = 30 * 60_000,
): ErrorReport {
  const now = Date.now();
  const stats = getErrorStats(history, periodMs);
  const trends = analyzeTrends(history);

  // Build top-errors list with provider info
  const errorMap = new Map<
    ErrorEventType,
    { classification: ErrorClassification; count: number; lastSeen: number; providers: Set<string> }
  >();

  for (const event of history.events) {
    if (now - event.timestamp > periodMs) continue;

    const t = event.classification.type;
    const existing = errorMap.get(t);
    if (existing) {
      existing.count++;
      if (event.timestamp > existing.lastSeen) {
        existing.lastSeen = event.timestamp;
        existing.classification = event.classification;
      }
      if (event.provider) existing.providers.add(event.provider);
    } else {
      errorMap.set(t, {
        classification: event.classification,
        count: 1,
        lastSeen: event.timestamp,
        providers: event.provider ? new Set([event.provider]) : new Set(),
      });
    }
  }

  const topErrors: ReportEntry[] = [...errorMap.values()]
    .sort((a, b) => b.count - a.count)
    .map((e) => ({
      classification: e.classification,
      count: e.count,
      lastSeen: e.lastSeen,
      providers: [...e.providers],
    }));

  const recommendations = generateRecommendations(stats, trends);

  return {
    generatedAt: now,
    period: { startMs: now - periodMs, endMs: now },
    summary: stats,
    trends,
    topErrors,
    recommendations,
  };
}

/**
 * Generate actionable recommendations based on error stats and trends.
 */
function generateRecommendations(
  stats: ErrorStats,
  trends: ErrorTrend,
): string[] {
  const recs: string[] = [];
  const total = Math.max(stats.total, 1);

  // High rate of auth errors → check API key
  const authRate = (stats.byType.auth_error ?? 0) / total;
  if (authRate > 0.3) {
    recs.push("High rate of authentication errors \u2014 verify API keys and credentials");
  }

  // Increasing trend → something is getting worse
  if (trends.direction === "increasing") {
    recs.push("Error rate is increasing \u2014 investigate recent changes or provider status");
  }

  // Hotspots → specific error types spiking
  for (const hotspot of trends.hotspots) {
    if (hotspot.spikeRatio > 3) {
      recs.push(
        `Spike detected in ${hotspot.type} errors (${hotspot.spikeRatio.toFixed(1)}x normal)`,
      );
    }
  }

  // High rate of context overflow → consider context management
  const overflowRate = (stats.byType.context_overflow ?? 0) / total;
  if (overflowRate > 0.2) {
    recs.push("Frequent context overflow \u2014 consider enabling compaction or reducing context");
  }

  // High rate of quota errors → billing issue
  const quotaTotal =
    (stats.byType.quota_exceeded ?? 0) +
    (stats.byType.quota_temporary ?? 0) +
    (stats.byType.quota_unknown ?? 0);
  if (quotaTotal / total > 0.3) {
    recs.push("Frequent quota errors \u2014 check billing and usage limits");
  }

  // High rate of overloaded errors → provider capacity issue
  const overloadedRate = (stats.byType.overloaded ?? 0) / total;
  if (overloadedRate > 0.2) {
    recs.push(
      "Frequent provider overload errors \u2014 consider fallback chain or request spacing",
    );
  }

  // Provider concentration → single point of failure
  const providers = Object.entries(stats.byProvider);
  if (providers.length === 1 && stats.total > 10) {
    recs.push("All errors from single provider \u2014 consider fallback chain configuration");
  }

  // High rate of content filter → review content policy interaction
  const contentFilterRate = (stats.byType.content_filter ?? 0) / total;
  if (contentFilterRate > 0.15) {
    recs.push(
      "Frequent content filter violations \u2014 review prompt content or safety settings",
    );
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Pattern learning
// ---------------------------------------------------------------------------

/**
 * Add a custom error pattern at runtime.
 * Learned patterns are stored in the history and can be checked via
 * `getPatternMatches` to aid debugging and classification validation.
 */
export function learnPattern(
  history: ErrorHistory,
  name: string,
  pattern: RegExp,
): void {
  // Avoid duplicate names
  const existing = history.learnedPatterns.findIndex((lp) => lp.name === name);
  if (existing >= 0) {
    history.learnedPatterns[existing] = { name, pattern };
    return;
  }
  history.learnedPatterns.push({ name, pattern });
}

/** Retrieve all learned patterns from history. */
export function getLearnedPatterns(history: ErrorHistory): readonly LearnedPattern[] {
  return history.learnedPatterns;
}

/** Remove a learned pattern by name. Returns true if found and removed. */
export function removeLearnedPattern(history: ErrorHistory, name: string): boolean {
  const idx = history.learnedPatterns.findIndex((lp) => lp.name === name);
  if (idx < 0) return false;
  history.learnedPatterns.splice(idx, 1);
  return true;
}
