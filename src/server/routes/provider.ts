import { Hono } from 'hono'
import { apiError } from '../middleware/error.js'
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

  // 列出已配置 providers（apiKey 脱敏，不含明文）
  app.get('/', (c) => {
    const providers = ctx.config.providers.map((p) => ({
      name: p.name || (p as { _tag?: string })._tag || '',
      protocol: p.protocol,
      baseURL: p.baseURL ?? '',
      hasKey: !!p.apiKey,
    }))
    return c.json({ providers, defaultProvider: ctx.config.defaultProvider })
  })

  // 连接测试：用请求体里的凭据探测 /models，不污染 registry
  app.post('/test', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const { baseURL, apiKey } = body as TestBody
    if (!baseURL) return apiError(c, 400, 'BAD_REQUEST', 'baseURL is required')
    const result = await probeModels(baseURL, apiKey ?? '')
    return c.json(result, result.ok ? 200 : 200)
  })

  return app
}

export { createProviderRoute, probeModels }
