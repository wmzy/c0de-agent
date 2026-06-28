import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/** models.dev API URL，可通过环境变量覆盖。 */
const MODELS_DEV_URL = process.env.C0DE_MODELS_URL || 'https://models.dev/api.json'

/** 缓存 TTL：5 分钟。 */
const CACHE_TTL_MS = 5 * 60 * 1000

/** 内存缓存。 */
let memCache: { data: CatalogData; fetchedAt: number } | null = null

/** models.dev Provider 结构（仅取需要的字段）。 */
type CatalogProvider = {
  id: string
  name: string
  npm?: string
  api?: string
  env: string[]
  doc?: string
  modelCount: number
}

/** models.dev Model 结构（精简）。 */
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

/** 完整目录数据。 */
type CatalogData = Record<string, CatalogProviderInternal>

type CatalogProviderInternal = {
  id: string
  name: string
  npm?: string
  api?: string
  env: string[]
  doc?: string
  models: Record<string, CatalogModelInternal>
}

type CatalogModelInternal = {
  id: string
  name: string
  family?: string
  reasoning: boolean
  tool_call: boolean
  attachment: boolean
  temperature: boolean
  limit: { context: number; output: number }
  cost?: { input?: number; output?: number }
}

function getCachePath(): string {
  const cacheDir = join(process.cwd(), '.c0de', 'cache')
  return join(cacheDir, 'models-dev.json')
}

/** 清除内存 + 磁盘缓存（主要用于测试）。 */
function clearCatalogCache(): void {
  memCache = null
  const p = getCachePath()
  if (existsSync(p)) {
    try {
      unlinkSync(p)
    } catch {
      // 忽略删除失败
    }
  }
}

function readDiskCache(): { data: CatalogData; fetchedAt: number } | null {
  const p = getCachePath()
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as {
      data: CatalogData
      fetchedAt: number
    }
    return raw
  } catch {
    return null
  }
}

function writeDiskCache(data: CatalogData, fetchedAt: number): void {
  const cacheDir = join(process.cwd(), '.c0de', 'cache')
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
  writeFileSync(getCachePath(), JSON.stringify({ data, fetchedAt }, null, 2), 'utf-8')
}

/**
 * 获取 models.dev 目录数据（带缓存）。
 * 优先用内存缓存，其次磁盘缓存，最后发起网络请求。
 */
async function fetchCatalog(force = false): Promise<{ data: CatalogData; fetchedAt: number }> {
  const now = Date.now()
  if (!force && memCache && now - memCache.fetchedAt < CACHE_TTL_MS) {
    return memCache
  }

  const disk = readDiskCache()
  if (!force && disk && now - disk.fetchedAt < CACHE_TTL_MS) {
    memCache = disk
    return disk
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(MODELS_DEV_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const data = (await res.json()) as CatalogData
    const fetchedAt = now
    memCache = { data, fetchedAt }
    writeDiskCache(data, fetchedAt)
    return { data, fetchedAt }
  } catch (err) {
    // 网络失败时回退到磁盘缓存（即使过期）
    if (disk) {
      memCache = disk
      return disk
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** 把内部 Provider 结构转为前端需要的精简列表项。 */
function toProviderListItem(id: string, p: CatalogProviderInternal): CatalogProvider {
  return {
    id,
    name: p.name,
    npm: p.npm,
    api: p.api,
    env: p.env,
    doc: p.doc,
    modelCount: Object.keys(p.models).length,
  }
}

/** 把内部 Model 结构转为前端需要的精简列表项。 */
function toModelItem(m: CatalogModelInternal): CatalogModel {
  return {
    id: m.id,
    name: m.name,
    family: m.family,
    reasoning: m.reasoning,
    toolCall: m.tool_call,
    attachment: m.attachment,
    temperature: m.temperature,
    context: m.limit.context,
    output: m.limit.output,
    costInput: m.cost?.input,
    costOutput: m.cost?.output,
  }
}

function createCatalogRoute(ctx: ServerContext): Hono {
  const app = new Hono()
  void ctx

  // 列出所有 providers（精简）
  app.get('/providers', async (c) => {
    try {
      const { data } = await fetchCatalog()
      const providers = Object.entries(data)
        .map(([id, p]) => toProviderListItem(id, p))
        .sort((a, b) => a.name.localeCompare(b.name))
      return c.json({ providers })
    } catch (err) {
      return apiError(
        c,
        502,
        'CATALOG_FETCH_FAILED',
        `Failed to fetch models.dev catalog: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  // 获取指定 provider 的模型列表
  app.get('/providers/:id/models', async (c) => {
    const id = c.req.param('id')
    try {
      const { data } = await fetchCatalog()
      const provider = data[id]
      if (!provider) return apiError(c, 404, 'NOT_FOUND', `Provider "${id}" not found`)
      const models = Object.values(provider.models)
        .map(toModelItem)
        .sort((a, b) => a.name.localeCompare(b.name))
      return c.json({
        provider: toProviderListItem(id, provider),
        models,
      })
    } catch (err) {
      return apiError(
        c,
        502,
        'CATALOG_FETCH_FAILED',
        `Failed to fetch models.dev catalog: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  // 搜索 providers 和 models
  app.get('/search', async (c) => {
    const q = c.req.query('q')
    if (!q) return apiError(c, 400, 'BAD_REQUEST', 'Query parameter q is required')
    try {
      const { data } = await fetchCatalog()
      const lower = q.toLowerCase()
      const providers: CatalogProvider[] = []
      const models: Array<CatalogProvider & { model: CatalogModel }> = []
      for (const [id, p] of Object.entries(data)) {
        const item = toProviderListItem(id, p)
        const nameMatch = p.name.toLowerCase().includes(lower) || id.toLowerCase().includes(lower)
        if (nameMatch) providers.push(item)
        for (const m of Object.values(p.models)) {
          const modelItem = toModelItem(m)
          const modelMatch =
            m.name.toLowerCase().includes(lower) ||
            m.id.toLowerCase().includes(lower) ||
            m.family?.toLowerCase().includes(lower)
          if (modelMatch) models.push({ ...item, model: modelItem })
        }
      }
      return c.json({ providers, models })
    } catch (err) {
      return apiError(
        c,
        502,
        'CATALOG_FETCH_FAILED',
        `Failed to fetch models.dev catalog: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  // 刷新缓存
  app.post('/refresh', async (c) => {
    try {
      await fetchCatalog(true)
      return c.json({ refreshed: true })
    } catch (err) {
      return apiError(
        c,
        502,
        'CATALOG_FETCH_FAILED',
        `Failed to refresh models.dev catalog: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  return app
}

export { clearCatalogCache, createCatalogRoute, fetchCatalog }
