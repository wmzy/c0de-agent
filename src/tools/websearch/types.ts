/**
 * websearch 工具的统一类型、常量与工具函数。
 *
 * 来源：oh-my-pi（packages/coding-agent/src/web/search/）多后端 strategy 架构，
 * 裁剪适配 c0de-agent 的 data+functions 范式（无 class）。
 * 详见 docs/superpowers/specs/2026-06-30-websearch-tool-design.md §2-3。
 */

/** 后端标识。strategy 接口预留，未来可加 'exa' | 'searxng' | … */
type WebSearchProviderId = 'duckduckgo' | 'tavily' | 'brave'

/** 时效过滤窗口。各后端映射为各自 API 参数。 */
type Recency = 'day' | 'week' | 'month' | 'year'

/** 单条搜索来源（所有后端统一）。 */
type WebSearchSource = {
  title: string
  url: string
  snippet?: string
}

/** 统一搜索参数。 */
type WebSearchParams = {
  query: string
  limit?: number
  recency?: Recency
  signal?: AbortSignal
  /** Tavily/Brave 的 key（DuckDuckGo 不用）。 */
  apiKey?: string
  /** 测试注入；默认用 createFetch()。 */
  fetchImpl?: typeof fetch
}

/** 统一响应（所有后端统一）。 */
type WebSearchResponse = {
  provider: WebSearchProviderId
  /** Tavily 返回合成答案；DuckDuckGo/Brave 通常无。 */
  answer?: string
  sources: WebSearchSource[]
}

/** 后端 strategy 接口（data + functions，非 class）。 */
type WebSearchProvider = {
  id: WebSearchProviderId
  /** 是否当前可用（DuckDuckGo 恒真；Tavily/Brave 需 key）。驱动 'auto' 选择。 */
  isAvailable: (apiKey?: string) => boolean
  /** 执行搜索。 */
  search: (params: WebSearchParams) => Promise<WebSearchResponse>
}

/** 工具参数校验常量。 */
const DEFAULT_NUM_RESULTS = 8
const MAX_NUM_RESULTS = 20
const MIN_NUM_RESULTS = 1

/** clamp 结果数到 [MIN, MAX]；undefined/NaN 回退到 fallback。 */
function clampNumResults(n: number | undefined, fallback: number = DEFAULT_NUM_RESULTS): number {
  if (n === undefined || Number.isNaN(n)) return fallback
  return Math.min(MAX_NUM_RESULTS, Math.max(MIN_NUM_RESULTS, Math.trunc(n)))
}

export type {
  Recency,
  WebSearchParams,
  WebSearchProvider,
  WebSearchProviderId,
  WebSearchSource,
  WebSearchResponse,
}
export { DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS, MIN_NUM_RESULTS, clampNumResults }
