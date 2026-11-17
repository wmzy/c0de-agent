import type {
  CatalogModel,
  CatalogProvider,
  ProviderDetailResult,
  SearchResult,
} from '@shared/types/catalog.js'
import { get, post } from '@/services/api.js'

const catalogAPI = {
  /** 列出所有 providers。 */
  listProviders: () => get<{ providers: CatalogProvider[] }>('/api/catalog/providers'),
  /** 获取指定 provider 的模型列表。 */
  getProviderModels: (id: string) =>
    get<ProviderDetailResult>(`/api/catalog/providers/${encodeURIComponent(id)}/models`),
  /** 搜索 providers 和 models。 */
  search: (query: string) =>
    get<SearchResult>(`/api/catalog/search?q=${encodeURIComponent(query)}`),
  /** 刷新缓存。 */
  refresh: () => post<{ refreshed: boolean }>('/api/catalog/refresh'),
}

export type { CatalogModel, CatalogProvider, ProviderDetailResult, SearchResult }
export { catalogAPI }

/** catalog provider 列表查询键（ProviderCatalogDialog 左栏正本）。 */
export function catalogProvidersKey() {
  return ['catalog', 'providers'] as const
}

/** 指定 provider 的模型列表查询键——挂在 catalogProvidersKey 前缀树下，
 *  失效 ['catalog','providers'] 会连带刷新模型详情。 */
export function catalogProviderModelsKey(id: string) {
  return ['catalog', 'providers', id, 'models'] as const
}
