import type { Context } from 'hono'
import { Hono } from 'hono'
import { loadConfigScopes, mergeConfig } from '../../core/config.js'
import { decryptSecret } from '../../core/secret.js'
import { resolveRoute } from '../../llm/registry.js'
import { getProject } from '../../project/project.js'
import { apiError } from '../middleware/error.js'
import { buildRegistryFromConfig } from '../registry-config.js'
import type { ServerContext } from '../types.js'

/** 测试连接请求体。 */
type TestBody = {
  baseURL?: string
  apiKey?: string
}

type TestResult = { ok: true; models: string[] } | { ok: false; error: string }

/**
 * 用给定 baseURL/apiKey 探测 OpenAI 兼容的 /models 端点。
 * baseURL 应自行包含版本路径（如 https://api.openai.com/v1）。
 */
async function probeModels(baseURL: string, apiKey: string): Promise<TestResult> {
  const base = baseURL.replace(/\/+$/, '')
  const url = `${base}/models`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200) || res.statusText}` }
    }
    const json = (await res.json()) as { data?: { id?: string }[] }
    const models = Array.isArray(json.data)
      ? json.data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
      : []
    return { ok: true, models }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

function createProviderRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  /** P1-1：解析目标项目配置与注册表（?projectId= 提供时按该项目合并配置）。
   *  项目配置从磁盘实时读取（配置体量小）；注册表优先用会话聊天路径缓存的。 */
  const resolveForProject = async (c: Context) => {
    const projectId = c.req.query('projectId')
    if (!projectId) return { config: ctx.config, registry: ctx.llmRegistry }
    const project = await getProject(ctx.db, projectId)
    if (!project) return null
    const scopes = loadConfigScopes(project.worktree)
    const config = mergeConfig(scopes.global, scopes.project)
    const registry = config.providers.length > 0 ? buildRegistryFromConfig(config) : ctx.llmRegistry
    return { config, registry }
  }

  // 列出已配置 providers（apiKey 脱敏，不含明文）
  app.get('/', async (c) => {
    const resolved = await resolveForProject(c)
    if (!resolved) return apiError(c, 404, 'PROJECT_NOT_FOUND', '项目不存在')
    const providers = resolved.config.providers.map((p) => ({
      name: p.name || (p as { _tag?: string })._tag || '',
      protocol: p.protocol,
      baseURL: p.baseURL ?? '',
      hasKey: !!p.apiKey,
    }))
    return c.json({ providers, defaultProvider: resolved.config.defaultProvider })
  })

  // 模型能力查询：前端据此控制多模态入口（supportsVision）等
  app.get('/capabilities', async (c) => {
    const provider = c.req.query('provider')
    const model = c.req.query('model')
    if (!provider || !model) {
      return apiError(c, 400, 'BAD_REQUEST', 'provider and model are required')
    }
    const project = await resolveForProject(c)
    if (!project) return apiError(c, 404, 'PROJECT_NOT_FOUND', '项目不存在')
    try {
      const route = resolveRoute(project.registry, provider, model)
      return c.json({
        provider,
        model,
        supportsVision: route.capabilities.supportsVision,
        supportsThinking: route.capabilities.supportsThinking,
        contextWindow: route.capabilities.contextWindow,
      })
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'provider/model not registered')
    }
  })

  // 连接测试：用请求体里的凭据探测 /models，不污染 registry
  app.post('/test', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const { baseURL, apiKey } = body as TestBody
    if (!baseURL) return apiError(c, 400, 'BAD_REQUEST', 'baseURL is required')
    // apiKey 可能是 Settings 页回传的 enc: 密文（保存后刷新、未重输时）：探测前解密，
    // 否则把 enc: 串当 Bearer token 发给上游必然 401，造成「保存了却测试失败」的误判。
    const secret = apiKey ? decryptSecret(apiKey) : ''
    const result = await probeModels(baseURL, secret)
    return c.json(result, result.ok ? 200 : 200)
  })

  return app
}

export { createProviderRoute, probeModels }
