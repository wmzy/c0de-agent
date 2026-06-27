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

/** Whether a reason is retryable (RateLimit / ProviderInternal). */
const reasonRetryable = (reason: LLMErrorReason): boolean =>
  reason._tag === 'RateLimit' || reason._tag === 'ProviderInternal'

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

export type { HttpContext, LLMError, LLMErrorReason, ToolFailure }
export {
  isLLMError,
  isToolFailure,
  llmError,
  reasonMessage,
  reasonRetryAfterMs,
  reasonRetryable,
  toolFailure,
}
