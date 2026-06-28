import { apiRequest } from './api.js'

/** models.dev 目录中的 Provider 列表项。 */
type CatalogProvider = {
  id: string
  name: string
  npm?: string
  api?: string
  env: string[]
  doc?: string
  modelCount: number
}

/** models.dev 目录中的 Model 列表项。 */
type CatalogModel = {
  id: string
  name: string
  family?: string
  reasoning: boolean
  toolCall: boolean
  attachment: boolean
  temperature: boolean
  context: number
  output: number
  costInput?: number
  costOutput?: number
}

/** Provider + 模型列表响应。 */
type ProviderDetailResult = {
  provider: CatalogProvider
  models: CatalogModel[]
}

/** 搜索结果。 */
type SearchResult = {
  providers: CatalogProvider[]
  models: Array<CatalogProvider & { model: CatalogModel }>
}

const catalogAPI = {
  /** 列出所有 providers。 */
  listProviders: () => apiRequest<{ providers: CatalogProvider[] }>('/api/catalog/providers'),
  /** 获取指定 provider 的模型列表。 */
  getProviderModels: (id: string) =>
    apiRequest<ProviderDetailResult>(`/api/catalog/providers/${encodeURIComponent(id)}/models`),
  /** 搜索 providers 和 models。 */
  search: (query: string) =>
    apiRequest<SearchResult>(`/api/catalog/search?q=${encodeURIComponent(query)}`),
  /** 刷新缓存。 */
  refresh: () => apiRequest<{ refreshed: boolean }>('/api/catalog/refresh', { method: 'POST' }),
}

export type { CatalogModel, CatalogProvider, ProviderDetailResult, SearchResult }
export { catalogAPI }
