import type { WebSearchConfig } from '../../shared/types/config.js'
import { braveProvider } from './providers/brave.js'
import { duckduckgoProvider } from './providers/duckduckgo.js'
import { tavilyProvider } from './providers/tavily.js'
import { createFetch } from './fetch.js'
import { clampNumResults, DEFAULT_NUM_RESULTS } from './types.js'
import type { Recency, WebSearchProvider, WebSearchProviderId, WebSearchResponse } from './types.js'

const PROVIDERS: Record<WebSearchProviderId, WebSearchProvider> = {
  duckduckgo: duckduckgoProvider,
  tavily: tavilyProvider,
  brave: braveProvider,
}

/** 环境变量名 → config key 字段映射。环境变量优先于 config。 */
function resolveKeys(config: WebSearchConfig): { tavily?: string; brave?: string } {
  return {
    tavily: process.env.TAVILY_API_KEY ?? config.tavilyApiKey,
    brave: process.env.BRAVE_API_KEY ?? config.braveApiKey,
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

/** 工具入口：解析 provider → search → 返回 WebSearchResponse。 */
export async function runWebSearch(
  input: { query: string; numResults?: number; recency?: Recency },
  config: WebSearchConfig,
  abort: AbortSignal,
): Promise<WebSearchResponse> {
  const keys = resolveKeys(config)
  const provider = resolveProvider(config.provider, keys)
  return provider.search({
    query: input.query,
    limit: clampNumResults(input.numResults),
    recency: input.recency,
    signal: abort,
    apiKey: provider.id === 'tavily' ? keys.tavily : provider.id === 'brave' ? keys.brave : undefined,
    fetchImpl: currentFetch(),
  })
}

export { clampNumResults, DEFAULT_NUM_RESULTS }
