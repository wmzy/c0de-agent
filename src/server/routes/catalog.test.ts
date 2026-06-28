// catalog 路由测试，对应 src/server/routes/catalog.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { clearCatalogCache, createCatalogRoute } from './catalog.js'

let dbHandle: DB | undefined

beforeEach(() => {
  clearCatalogCache()
})

afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
  clearCatalogCache()
  vi.restoreAllMocks()
})

const mockCatalog = {
  'test-provider': {
    id: 'test-provider',
    name: 'Test Provider',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.test-provider.com/v1',
    env: ['TEST_PROVIDER_API_KEY'],
    doc: 'https://docs.test-provider.com',
    models: {
      'gpt-4o': {
        id: 'gpt-4o',
        name: 'GPT-4o',
        family: 'gpt-4',
        reasoning: false,
        tool_call: true,
        attachment: true,
        temperature: true,
        limit: { context: 128000, output: 16384 },
        cost: { input: 2.5, output: 10 },
      },
      'o1-mini': {
        id: 'o1-mini',
        name: 'o1-mini',
        family: 'o1',
        reasoning: true,
        tool_call: true,
        attachment: false,
        temperature: false,
        limit: { context: 65536, output: 100000 },
      },
    },
  },
  'another-provider': {
    id: 'another-provider',
    name: 'Another AI',
    npm: '@ai-sdk/anthropic',
    api: 'https://api.another.com',
    env: ['ANOTHER_API_KEY'],
    models: {
      'claude-3': {
        id: 'claude-3',
        name: 'Claude 3',
        reasoning: true,
        tool_call: true,
        attachment: true,
        temperature: true,
        limit: { context: 200000, output: 8192 },
      },
    },
  },
}

function mockFetchResponse(data: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  const ctx = createServerContext({ db, llmRegistry: createRegistry() })
  const app = createCatalogRoute(ctx)
  return { app, ctx }
}

describe('catalog route', () => {
  it('GET /providers returns sorted provider list', async () => {
    mockFetchResponse(mockCatalog)
    const { app } = await setup()
    const res = await app.request('/providers')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      providers: { id: string; name: string; modelCount: number }[]
    }
    expect(body.providers).toHaveLength(2)
    expect(body.providers[0]?.name).toBe('Another AI')
    expect(body.providers[1]?.name).toBe('Test Provider')
    expect(body.providers[0]?.modelCount).toBe(1)
    expect(body.providers[1]?.modelCount).toBe(2)
  })

  it('GET /providers/:id/models returns models for provider', async () => {
    mockFetchResponse(mockCatalog)
    const { app } = await setup()
    const res = await app.request('/providers/test-provider/models')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      provider: { id: string }
      models: { id: string; name: string; reasoning: boolean; context: number }[]
    }
    expect(body.provider.id).toBe('test-provider')
    expect(body.models).toHaveLength(2)
    const gpt4o = body.models.find((m) => m.id === 'gpt-4o')
    expect(gpt4o?.reasoning).toBe(false)
    expect(gpt4o?.context).toBe(128000)
    const o1 = body.models.find((m) => m.id === 'o1-mini')
    expect(o1?.reasoning).toBe(true)
  })

  it('GET /providers/:id/models returns 404 for unknown provider', async () => {
    mockFetchResponse(mockCatalog)
    const { app } = await setup()
    const res = await app.request('/providers/nonexistent/models')
    expect(res.status).toBe(404)
  })

  it('GET /search filters providers by name', async () => {
    mockFetchResponse(mockCatalog)
    const { app } = await setup()
    const res = await app.request('/search?q=another')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      providers: { id: string }[]
      models: unknown[]
    }
    expect(body.providers).toHaveLength(1)
    expect(body.providers[0]?.id).toBe('another-provider')
  })

  it('GET /search filters models by name', async () => {
    mockFetchResponse(mockCatalog)
    const { app } = await setup()
    const res = await app.request('/search?q=gpt')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      providers: unknown[]
      models: { id: string; model: { id: string } }[]
    }
    expect(body.models).toHaveLength(1)
    expect(body.models[0]?.model.id).toBe('gpt-4o')
  })

  it('GET /search requires query parameter', async () => {
    mockFetchResponse(mockCatalog)
    const { app } = await setup()
    const res = await app.request('/search')
    expect(res.status).toBe(400)
  })

  it('GET /providers returns 502 on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'))
    const { app } = await setup()
    const res = await app.request('/providers')
    expect(res.status).toBe(502)
  })

  it('POST /refresh forces re-fetch', async () => {
    const spy = mockFetchResponse(mockCatalog)
    const { app } = await setup()
    // 首次加载
    await app.request('/providers')
    const firstCallCount = spy.mock.calls.length
    // 刷新
    const res = await app.request('/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { refreshed: boolean }
    expect(body.refreshed).toBe(true)
    expect(spy.mock.calls.length).toBeGreaterThan(firstCallCount)
  })
})
