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
        initialDelayMs: chain.retryDelay,
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

/** 回退目标所需的最小 provider 信息。 */
type FallbackSourceProvider = {
  name?: string
  _tag?: string
  /** 声明了模型清单的 provider 只对清单内的模型回退；未声明视为不支持（保守）。 */
  models?: Record<string, unknown>
}

/**
 * 从 config.fallback 构建回退链（主 chat 循环/压缩/标题等 LLM 调用的接线点）。
 * - enabled=false → undefined（保持内置默认：3 次重试、无跨 provider 回退）。
 * - enabled=true → 按配置 maxRetries/retryDelay 重试，并对「声明了同一模型」的
 *   其他 provider 依次回退。无合格回退目标时 fallbacks 为空——重试参数仍然生效。
 * 回退只接受声明了该模型的 provider：对未声明的 provider 盲目回退会在其 API 处
 * 得到 InvalidRequest 并中断整条链（shouldFallOver 不放过非回退错误）。
 */
function buildFallbackChain(
  config: {
    providers: FallbackSourceProvider[]
    fallback: { enabled: boolean; maxRetries: number; retryDelay: number }
  },
  provider: string,
  model: string,
): FallbackChain | undefined {
  const fb = config.fallback
  if (!fb.enabled) return undefined
  const fallbacks = config.providers
    .filter((p) => {
      const name = p.name || p._tag
      if (!name || name === provider) return false
      return p.models !== undefined && model in p.models
    })
    .map((p) => ({ provider: (p.name || p._tag) as string, model }))
  return {
    primary: { provider, model },
    fallbacks,
    maxRetries: fb.maxRetries,
    retryDelay: fb.retryDelay,
  }
}

export type { FallbackChain }
export { buildFallbackChain, runWithFallback, shouldFallOver }
