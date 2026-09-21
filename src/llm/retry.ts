import { MAX_TIMER_MS } from '../shared/timer.js'
import type { LLMErrorReason, RetryPolicy } from './schema/errors.js'
import { isLLMError, reasonRetryAfterMs, retryPolicy } from './schema/errors.js'

const RETRY_INITIAL_DELAY = 2_000
const RETRY_BACKOFF_FACTOR = 2
const RETRY_MAX_DELAY_NO_HEADERS = 30_000
/** 32 位 timer 安全上限（> 此值 setTimeout 钳到 1ms）；与 shared MAX_TIMER_MS 单一来源。 */
const RETRY_MAX_DELAY = MAX_TIMER_MS

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

/** 严格解析「正有限毫秒数」：Infinity（'1e999'）/NaN/负数/零一律拒绝。
 *  parseFloat('1e999') = Infinity 能穿过 Number.isNaN 检查——capDelay(Infinity)
 *  后单次重试延迟 2^31ms ≈ 24.8 天，且 RateLimit 的 policy maxDelay=Infinity
 *  不拦截，agent run 实际挂死。 */
const parsePositiveFinite = (s: string): number | null => {
  const n = Number.parseFloat(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Compute the delay before the next retry attempt (ms).
 * Honors retry-after / retry-after-ms headers when present, else exponential backoff
 * from the given base delay (defaults to RETRY_INITIAL_DELAY).
 */
const delay = (attempt: number, error?: unknown, initialDelayMs = RETRY_INITIAL_DELAY): number => {
  const headers = errorHeaders(error)
  // 无可用重试指示时统一 30s 上限退避。此前仅无 headers 路径 cap 30s——headers
  // 存在但缺/坏 retry-after（如 500 错误携带其他头）时退避无上限，attempt=10
  // 即膨胀到 2^9*2000 ≈ 17 分钟。
  const backoff = (): number =>
    capDelay(
      Math.min(initialDelayMs * RETRY_BACKOFF_FACTOR ** (attempt - 1), RETRY_MAX_DELAY_NO_HEADERS),
    )
  if (headers) {
    const retryAfterMs = headers['retry-after-ms']
    if (retryAfterMs !== undefined) {
      const parsedMs = parsePositiveFinite(retryAfterMs)
      if (parsedMs !== null) return capDelay(parsedMs)
    }
    const retryAfter = headers['retry-after']
    if (retryAfter !== undefined) {
      const parsedSeconds = parsePositiveFinite(retryAfter)
      if (parsedSeconds !== null) return capDelay(Math.ceil(parsedSeconds * 1000))
      const parsed = Date.parse(retryAfter) - Date.now()
      if (!Number.isNaN(parsed) && parsed > 0) return capDelay(Math.ceil(parsed))
    }
  }
  return backoff()
}

/** A normalized, retryable error descriptor for the session layer. */
type Retryable = {
  message: string
  reason: LLMErrorReason
  /** Per-reason policy: caps extra retries and per-attempt delay. */
  policy: RetryPolicy
}

/**
 * Decide whether a thrown error is retryable. Returns undefined when not retryable
 * (e.g. context overflow, auth, invalid request, mid-stream Transport failure).
 */
const retryable = (error: unknown): Retryable | undefined => {
  if (!isLLMError(error)) return undefined
  const reason = error.reason
  const policy = retryPolicy(reason)
  if (!policy) return undefined
  return { message: error.message, reason, policy }
}

type RetryOptions = {
  maxRetries: number
  /** Override sleep for testing. Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>
  /** Called with each retry attempt metadata. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
  /** Base delay for exponential backoff (default RETRY_INITIAL_DELAY). */
  initialDelayMs?: number
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
      if (!canRetry || attempt >= Math.min(options.maxRetries, canRetry.policy.maxRetries))
        throw error
      attempt += 1
      const fallbackReason: LLMErrorReason = isLLMError(error)
        ? error.reason
        : { _tag: 'InvalidRequest', message: '' }
      const delayMs = Math.min(
        reasonRetryAfterMs(fallbackReason) ?? delay(attempt, error, options.initialDelayMs),
        canRetry.policy.maxDelay,
      )
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
