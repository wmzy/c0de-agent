/**
 * Catalog shared types — models.dev provider/model catalog, used by the
 * server routes (src/server/routes/catalog.ts) and the frontend service
 * (src/web/services/catalog.ts). Previously hand-mirrored on both sides.
 */

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

export type { CatalogModel, CatalogProvider, ProviderDetailResult, SearchResult }
