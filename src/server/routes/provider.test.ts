import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import type { Config } from '../../shared/types/config.js'
import { createServerContext } from '../context.js'
import { createProviderRoute } from './provider.js'

let dbHandle: DB | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
  vi.restoreAllMocks()
})

async function setup(config?: Partial<Config>) {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  const ctx = createServerContext({ db, llmRegistry: createRegistry(), config: config as Config })
  const app = createProviderRoute(ctx)
  return { app, ctx }
}

describe('provider route', () => {
  it('GET / returns configured providers with masked apiKey', async () => {
    const { app } = await setup({
      providers: [
        {
          name: 'openai',
          protocol: 'openai',
          apiKey: 'sk-secret',
          baseURL: 'https://api.openai.com/v1',
        },
      ],
      defaultProvider: 'openai',
    })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      providers: { name: string; hasKey: boolean }[]
      defaultProvider: string
    }
    expect(body.providers).toHaveLength(1)
    const first = body.providers[0] as { name: string; hasKey: boolean }
    expect(first.name).toBe('openai')
    expect(first.hasKey).toBe(true)
    expect(JSON.stringify(body)).not.toContain('sk-secret')
  })

  it('POST /test returns 400 when baseURL missing', async () => {
    const { app } = await setup()
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('POST /test returns ok + models on successful probe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const { app } = await setup()
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; models: string[] }
    expect(body.ok).toBe(true)
    expect(body.models).toEqual(['gpt-4o', 'gpt-4o-mini'])
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [firstArg] = fetchSpy.mock.calls[0] ?? []
    const calledUrl = String(firstArg)
    expect(calledUrl).toBe('https://api.openai.com/v1/models')
  })

  it('POST /test returns error when fetch rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    const { app } = await setup()
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x' }),
    })
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('network down')
  })

  it('POST /test returns error on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const { app } = await setup()
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL: 'https://api.openai.com/v1', apiKey: 'bad' }),
    })
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('401')
  })
})
