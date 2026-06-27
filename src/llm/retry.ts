import type { LLMErrorReason } from './schema/errors.js'
import { isLLMError, reasonRetryAfterMs, reasonRetryable } from './schema/errors.js'

const RETRY_INITIAL_DELAY = 2_000
const RETRY_BACKOFF_FACTOR = 2
const RETRY_MAX_DELAY_NO_HEADERS = 30_000
const RETRY_MAX_DELAY = 2_147_483_647

/** Extract response headers from an LLMError's http context (if any). */
const errorHeaders = (error: unknown): Record<string, string> | undefined => {
  if (!isLLMError(error)) return undefined
  const reason = error.reason
  if ('http' in reason && reason.http?.response) {
    return reason.http.response.headers
  }
  return undefined
}

/** Cap a delay to the 32-bit safe ceiling. */
const capDelay = (ms: number): number => Math.min(ms, RETRY_MAX_DELAY)

/**
 * Compute the delay before the next retry attempt (ms).
 * Honors retry-after / retry-after-ms headers when present, else exponential backoff.
 */
const delay = (attempt: number, error?: unknown): number => {
  const headers = errorHeaders(error)
  if (headers) {
    const retryAfterMs = headers['retry-after-ms']
    if (retryAfterMs !== undefined) {
      const parsedMs = Number.parseFloat(retryAfterMs)
      if (!Number.isNaN(parsedMs)) return capDelay(parsedMs)
    }
    const retryAfter = headers['retry-after']
    if (retryAfter !== undefined) {
      const parsedSeconds = Number.parseFloat(retryAfter)
      if (!Number.isNaN(parsedSeconds)) return capDelay(Math.ceil(parsedSeconds * 1000))
      const parsed = Date.parse(retryAfter) - Date.now()
      if (!Number.isNaN(parsed) && parsed > 0) return capDelay(Math.ceil(parsed))
    }
    return capDelay(RETRY_INITIAL_DELAY * RETRY_BACKOFF_FACTOR ** (attempt - 1))
  }
  return capDelay(
    Math.min(
      RETRY_INITIAL_DELAY * RETRY_BACKOFF_FACTOR ** (attempt - 1),
      RETRY_MAX_DELAY_NO_HEADERS,
    ),
  )
}

/** A normalized, retryable error descriptor for the session layer. */
type Retryable = {
  message: string
  reason: LLMErrorReason
}

/**
 * Decide whether a thrown error is retryable. Returns undefined when not retryable
 * (e.g. context overflow, auth, invalid request).
 */
const retryable = (error: unknown): Retryable | undefined => {
  if (!isLLMError(error)) return undefined
  const reason = error.reason
  if (!reasonRetryable(reason)) return undefined
  return { message: error.message, reason }
}

type RetryOptions = {
  maxRetries: number
  /** Override sleep for testing. Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Called with each retry attempt metadata. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run an async operation with retry. Retries only on retryable LLM errors.
 * Non-retryable errors (including context overflow) are re-thrown immediately.
 */
const withRetry = async <T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> => {
  const sleep = options.sleep ?? defaultSleep
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      const canRetry = retryable(error)
      if (!canRetry || attempt >= options.maxRetries) throw error
      attempt += 1
      const fallbackReason: LLMErrorReason = isLLMError(error)
        ? error.reason
        : { _tag: 'InvalidRequest', message: '' }
      const delayMs = reasonRetryAfterMs(fallbackReason) ?? delay(attempt, error)
      options.onRetry?.({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }
}

export type { Retryable, RetryOptions }
export {
  delay,
  RETRY_INITIAL_DELAY,
  RETRY_MAX_DELAY,
  RETRY_MAX_DELAY_NO_HEADERS,
  retryable,
  withRetry,
}
