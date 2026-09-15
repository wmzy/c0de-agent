import { decryptSecret } from '../../core/secret.js'
import type { WebSearchConfig } from '../../shared/types/config.js'
import { createFetch } from './fetch.js'
import { braveProvider } from './providers/brave.js'
import { duckduckgoProvider } from './providers/duckduckgo.js'
import { tavilyProvider } from './providers/tavily.js'
import type { Recency, WebSearchProvider, WebSearchProviderId, WebSearchResponse } from './types.js'
import { clampNumResults, DEFAULT_NUM_RESULTS } from './types.js'

const PROVIDERS: Record<WebSearchProviderId, WebSearchProvider> = {
  duckduckgo: duckduckgoProvider,
  tavily: tavilyProvider,
  brave: braveProvider,
}

/** 环境变量名 → config key 字段映射。环境变量优先于 config。
 *  config 值落盘时已加密（enc: 前缀），此处解密后使用（明文兼容透传）。 */
function resolveKeys(config: WebSearchConfig): { tavily?: string; brave?: string } {
  const decrypt = (v?: string) => (v ? decryptSecret(v) : v)
  return {
    tavily: process.env.TAVILY_API_KEY ?? decrypt(config.tavilyApiKey),
    brave: process.env.BRAVE_API_KEY ?? decrypt(config.braveApiKey),
  }
}

/** 按 preference + key 可用性解析目标 provider。auto 优先级：tavily > brave > duckduckgo。 */
export function resolveProvider(
  preference: 'auto' | WebSearchProviderId,
  keys: { tavily?: string; brave?: string },
): WebSearchProvider {
  if (preference === 'auto') {
    if (tavilyProvider.isAvailable(keys.tavily)) return tavilyProvider
    if (braveProvider.isAvailable(keys.brave)) return braveProvider
    return duckduckgoProvider
  }
  const provider = PROVIDERS[preference]
  if (!provider) throw new Error(`Unknown websearch provider: ${preference}`)
  if (!provider.isAvailable(preference === 'tavily' ? keys.tavily : keys.brave)) {
    throw new Error(
      `${preference} provider requires an API key (set ${
        preference === 'tavily' ? 'TAVILY_API_KEY' : 'BRAVE_API_KEY'
      } or config).`,
    )
  }
  return provider
}

const SNIPPET_MAX = 240

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 将统一响应格式化为 LLM 友好的纯文本。 */
export function formatForLLM(response: WebSearchResponse): string {
  const parts: string[] = []
  if (response.answer?.trim()) {
    parts.push(response.answer.trim())
  }
  if (response.sources.length > 0) {
    parts.push(`## Sources (${response.sources.length})`)
    for (const [i, src] of response.sources.entries()) {
      parts.push(`[${i + 1}] ${src.title}`)
      parts.push(`    ${src.url}`)
      if (src.snippet) parts.push(`    ${truncate(src.snippet, SNIPPET_MAX)}`)
    }
  }
  return parts.join('\n')
}

/** 模块级 fetch 覆盖（测试注入）。undefined 时用 createFetch()。 */
let fetchOverride: typeof fetch | undefined

/** 测试钩子：覆盖默认 fetch（undici ProxyAgent 包装版）。 */
export function setFetchOverride(f: typeof fetch | undefined): void {
  fetchOverride = f
}

function currentFetch(): typeof fetch {
  return fetchOverride ?? createFetch()
}

/** 运行时降级判定：鉴权失效（key 过期/被撤）、限流、服务端错误可换后端重试；
 *  4xx 参数错误（400 等）换后端无意义；网络层错误（无 status）也降级（该后端连通性
 *  问题，duckduckgo 兜底）。 */
function isFallbackable(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status
  return (
    typeof status !== 'number' ||
    status >= 500 ||
    status === 401 ||
    status === 403 ||
    status === 429
  )
}

/** 工具入口：解析 provider → search → 返回 WebSearchResponse。
 *  'auto' 模式带运行时降级链：候选后端按 key 可用性排列（tavily > brave >
 *  duckduckgo），当前后端因鉴权/限流/服务端/网络错误失败时依次降级——
 *  此前 auto 只按 key **存在性**选一次，key 失效/过期即整体失败。
 *  显式指定后端时尊重用户选择，单后端不降级。abort 立即上抛，不沿链继续。 */
export async function runWebSearch(
  input: { query: string; numResults?: number; recency?: Recency },
  config: WebSearchConfig,
  abort: AbortSignal,
): Promise<WebSearchResponse> {
  const keys = resolveKeys(config)
  const apiKeyFor = (provider: WebSearchProvider) =>
    provider.id === 'tavily' ? keys.tavily : provider.id === 'brave' ? keys.brave : undefined
  const search = (provider: WebSearchProvider) =>
    provider.search({
      query: input.query,
      limit: clampNumResults(input.numResults),
      recency: input.recency,
      signal: abort,
      apiKey: apiKeyFor(provider),
      fetchImpl: currentFetch(),
    })

  if (config.provider === 'auto') {
    const chain = [tavilyProvider, braveProvider, duckduckgoProvider].filter((p) =>
      p.isAvailable(apiKeyFor(p)),
    )
    let lastError: unknown = null
    for (const provider of chain) {
      try {
        return await search(provider)
      } catch (err) {
        if (abort.aborted) throw err
        if (!isFallbackable(err)) throw err
        lastError = err
      }
    }
    if (lastError instanceof Error) throw lastError
    throw new Error(`websearch 无可用后端：${String(lastError)}`)
  }

  const provider = resolveProvider(config.provider, keys)
  return search(provider)
}

export { clampNumResults, DEFAULT_NUM_RESULTS }
