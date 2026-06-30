import { DEFAULT_NUM_RESULTS } from '../types.js'
import type {
  Recency,
  WebSearchParams,
  WebSearchProvider,
  WebSearchResponse,
  WebSearchSource,
} from '../types.js'

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'

interface BraveResult {
  title?: string | null
  url?: string | null
  description?: string | null
}
interface BraveSearchResponse {
  web?: { results?: BraveResult[] } | null
}

/** 导出供测试：recency → Brave freshness 代码映射。 */
export function recencyToFreshness(recency: Recency | undefined): string | undefined {
  switch (recency) {
    case 'day':
      return 'pd'
    case 'week':
      return 'pw'
    case 'month':
      return 'pm'
    case 'year':
      return 'py'
    default:
      return undefined
  }
}

/** Brave 后端（独立索引，需 key）。 */
export const braveProvider: WebSearchProvider = {
  id: 'brave',
  isAvailable: (apiKey?: string) => Boolean(apiKey && apiKey.length > 0),
  search: async (params: WebSearchParams): Promise<WebSearchResponse> => {
    if (!params.apiKey) throw new Error('Brave requires an API key (BRAVE_API_KEY or config).')
    const fetchImpl = params.fetchImpl ?? fetch
    const count = params.limit ?? DEFAULT_NUM_RESULTS
    const query = new URLSearchParams({ q: params.query, count: String(count) })
    const freshness = recencyToFreshness(params.recency)
    if (freshness) query.set('freshness', freshness)

    const response = await fetchImpl(`${BRAVE_SEARCH_URL}?${query.toString()}`, {
      method: 'GET',
      headers: {
        'X-Subscription-Token': params.apiKey,
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
      },
      signal: params.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText)
      throw new Error(`Brave API error (${response.status}): ${text}`)
    }
    const data = (await response.json()) as BraveSearchResponse
    const sources: WebSearchSource[] = []
    for (const r of data.web?.results ?? []) {
      if (!r.url) continue
      sources.push({ title: r.title ?? r.url, url: r.url, snippet: r.description ?? undefined })
    }
    return { provider: 'brave', sources }
  },
}
