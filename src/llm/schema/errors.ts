type HttpContext = {
  request: { method: string; url: string; headers: Record<string, string> }
  response?: { status: number; headers: Record<string, string> }
  body?: string
  requestId?: string
}

type LLMErrorReason =
  | {
      _tag: 'InvalidRequest'
      message: string
      parameter?: string
      classification?: 'context-overflow'
      http?: HttpContext
    }
  | { _tag: 'NoRoute'; route: string; provider: string; model: string }
  | {
      _tag: 'Authentication'
      message: string
      kind: 'missing' | 'invalid' | 'expired' | 'insufficient-permissions' | 'unknown'
      http?: HttpContext
    }
  | {
      _tag: 'RateLimit'
      message: string
      retryAfterMs?: number
      http?: HttpContext
    }
  | { _tag: 'QuotaExceeded'; message: string; http?: HttpContext }
  | { _tag: 'ContentPolicy'; message: string; http?: HttpContext }
  | {
      _tag: 'ProviderInternal'
      message: string
      status: number
      retryAfterMs?: number
      http?: HttpContext
    }
  | { _tag: 'Transport'; message: string; kind?: string; url?: string; http?: HttpContext }
  | { _tag: 'InvalidProviderOutput'; message: string; raw?: string }
  | { _tag: 'UnknownProvider'; message: string; status?: number; http?: HttpContext }

/** Human-readable message extracted from any reason. */
const reasonMessage = (reason: LLMErrorReason): string => {
  switch (reason._tag) {
    case 'NoRoute':
      return `No LLM route for model "${reason.model}" using provider "${reason.provider}" (route "${reason.route}")`
    default:
      return reason.message
  }
}

/** Per-reason retry policy. `maxRetries` caps extra attempts; `maxDelay` caps each delay (ms). */
type RetryPolicy = {
  maxRetries: number
  maxDelay: number
}

/** Maximum extra retries for transient Transport (network) errors (3 total attempts). */
const TRANSPORT_MAX_RETRIES = 2
/** Per-attempt delay ceiling (ms) for Transport retries, to avoid long stalls. */
const TRANSPORT_MAX_DELAY = 5_000

/**
 * Transport error kinds that are safe to retry — failures occurring before the
 * provider begins streaming a response (connection / DNS / TCP reset / timeout):
 * the request never reached the server (or the server never started processing),
 * so retrying cannot duplicate cost or yield partial output. A mid-stream
 * disconnect (e.g. a future `stream_interrupted` kind) is intentionally excluded,
 * since the provider already started billing/producing.
 */
const RETRYABLE_TRANSPORT_KINDS = new Set(['network'])

/**
 * Retry policy for a reason, or undefined when the reason is not retryable.
 * Single source of truth consulted by both `reasonRetryable` and the retry loop.
 */
const retryPolicy = (reason: LLMErrorReason): RetryPolicy | undefined => {
  switch (reason._tag) {
    case 'RateLimit':
    case 'ProviderInternal':
      // Defer entirely to the caller's limits; existing behavior is unchanged.
      return { maxRetries: Number.POSITIVE_INFINITY, maxDelay: Number.POSITIVE_INFINITY }
    case 'Transport':
      if (reason.kind !== undefined && RETRYABLE_TRANSPORT_KINDS.has(reason.kind)) {
        return { maxRetries: TRANSPORT_MAX_RETRIES, maxDelay: TRANSPORT_MAX_DELAY }
      }
      return undefined
    default:
      return undefined
  }
}

/** Whether a reason is retryable (RateLimit / ProviderInternal / transient Transport). */
const reasonRetryable = (reason: LLMErrorReason): boolean => retryPolicy(reason) !== undefined

/** Retry-after delay in ms for reasons that carry one. */
const reasonRetryAfterMs = (reason: LLMErrorReason): number | undefined => {
  if (reason._tag === 'RateLimit' || reason._tag === 'ProviderInternal') {
    return reason.retryAfterMs
  }
  return undefined
}

type LLMError = {
  _tag: 'LLMError'
  module: string
  method: string
  reason: LLMErrorReason
  message: string
}

const llmError = (module: string, method: string, reason: LLMErrorReason): LLMError => ({
  _tag: 'LLMError',
  module,
  method,
  reason,
  message: `${module}.${method}: ${reasonMessage(reason)}`,
})

const isLLMError = (e: unknown): e is LLMError =>
  typeof e === 'object' && e !== null && (e as { _tag?: string })._tag === 'LLMError'

type ToolFailure = {
  _tag: 'ToolFailure'
  message: string
  metadata?: Record<string, unknown>
}

const toolFailure = (message: string, metadata?: Record<string, unknown>): ToolFailure => ({
  _tag: 'ToolFailure',
  message,
  metadata,
})

const isToolFailure = (e: unknown): e is ToolFailure =>
  typeof e === 'object' && e !== null && (e as { _tag?: string })._tag === 'ToolFailure'

export type { HttpContext, LLMError, LLMErrorReason, RetryPolicy, ToolFailure }
export {
  isLLMError,
  isToolFailure,
  llmError,
  reasonMessage,
  reasonRetryAfterMs,
  reasonRetryable,
  retryPolicy,
  toolFailure,
}
