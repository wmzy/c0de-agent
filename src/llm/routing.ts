import type { Registry } from './registry.js'
import { resolveRoute } from './registry.js'
import { withRetry } from './retry.js'
import { isLLMError } from './schema/errors.js'

type FallbackChain = {
  primary: { provider: string; model: string }
  fallbacks: { provider: string; model: string }[]
  maxRetries: number
  retryDelay: number
  /** Override sleep for testing. */
  sleep?: (ms: number) => Promise<void>
}

type RunFn<T> = (provider: string, model: string) => Promise<T>

/**
 * Run `run` against the primary route first. If it throws a retryable error
 * that exhausts retries, try each fallback in order. Non-retryable errors
 * (context overflow, auth, invalid request) propagate immediately without
 * trying fallbacks.
 */
const runWithFallback = async <T>(
  registry: Registry,
  chain: FallbackChain,
  run: RunFn<T>,
): Promise<{ result: T; provider: string; model: string }> => {
  const targets = [chain.primary, ...chain.fallbacks]
  let lastError: unknown

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i]
    if (target === undefined) continue
    // Validate the route exists before attempting (fails fast with NoRoute).
    resolveRoute(registry, target.provider, target.model)
    try {
      const result = await withRetry(() => run(target.provider, target.model), {
        maxRetries: chain.maxRetries,
        sleep: chain.sleep,
      })
      return { result, provider: target.provider, model: target.model }
    } catch (error) {
      lastError = error
      // Non-retryable errors do not fall through to fallback.
      if (!shouldFallOver(error)) throw error
    }
  }
  throw lastError
}

/**
 * Whether an error should trigger a fallback after retries are exhausted.
 * Per spec §7.6: RateLimit (after retries), ProviderInternal, and Authentication
 * fall over to the next route. Context-overflow, invalid request, and transport
 * errors propagate without trying fallbacks.
 */
const shouldFallOver = (error: unknown): boolean => {
  if (!isLLMError(error)) return false
  const reason = error.reason
  if (reason._tag === 'ProviderInternal') return true
  if (reason._tag === 'RateLimit') return true
  if (reason._tag === 'Authentication') return true
  return false
}

export type { FallbackChain }
export { runWithFallback, shouldFallOver }
