import { DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS, MIN_NUM_RESULTS } from '../types.js'
import type {
  Recency,
  WebSearchParams,
  WebSearchProvider,
  WebSearchResponse,
  WebSearchSource,
} from '../types.js'

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'

interface TavilySearchParams {
  query: string
  numResults?: number
  recency?: Recency
}

interface TavilySearchResult {
  title?: string | null
  url?: string | null
  content?: string | null
  published_date?: string | null
}
interface TavilySearchResponse {
  answer?: string | null
  results?: TavilySearchResult[]
  request_id?: string | null
}

function clamp(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) return DEFAULT_NUM_RESULTS
  return Math.min(MAX_NUM_RESULTS, Math.max(MIN_NUM_RESULTS, Math.trunc(n)))
}

/** 导出供测试：构造 Tavily 请求 body。始终用 general topic（避免技术查询窄化为新闻）。 */
export function buildRequestBody(params: TavilySearchParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: params.query,
    search_depth: 'basic',
    max_results: clamp(params.numResults),
    include_answer: 'advanced',
    include_raw_content: false,
  }
  if (params.recency) body.time_range = params.recency
  return body
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function getErrorMessage(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim()
    return t.length > 0 ? t : null
  }
  const rec = asRecord(value)
  if (!rec) return null
  for (const key of ['detail', 'error', 'message']) {
    const m = getErrorMessage(rec[key])
    if (m) return m
  }
  return null
}

async function callTavilySearch(
  apiKey: string,
  params: WebSearchParams,
): Promise<TavilySearchResponse> {
  const fetchImpl = params.fetchImpl ?? fetch
  const response = await fetchImpl(TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(
      buildRequestBody({
        query: params.query,
        numResults: params.limit,
        recency: params.recency,
      }),
    ),
    signal: params.signal,
  })
  if (!response.ok) {
    const raw = await response.text().catch(() => response.statusText)
    const msg = getErrorMessage(safeParse(raw)) ?? (raw.trim() || response.statusText)
    throw new Error(`Tavily API error (${response.status}): ${msg}`)
  }
  return (await response.json()) as TavilySearchResponse
}

/** Tavily 后端（AI 优化搜索，需 key，返回合成 answer）。 */
export const tavilyProvider: WebSearchProvider = {
  id: 'tavily',
  isAvailable: (apiKey?: string) => Boolean(apiKey && apiKey.length > 0),
  search: async (params: WebSearchParams): Promise<WebSearchResponse> => {
    if (!params.apiKey)
      throw new Error('Tavily requires an API key (TAVILY_API_KEY or config).')
    const data = await callTavilySearch(params.apiKey, params)
    const sources: WebSearchSource[] = []
    for (const r of data.results ?? []) {
      if (!r.url) continue
      sources.push({ title: r.title ?? r.url, url: r.url, snippet: r.content ?? undefined })
    }
    return {
      provider: 'tavily',
      answer: data.answer?.trim() || undefined,
      sources: sources.slice(0, clamp(params.limit)),
    }
  },
}
