import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { createRegistry, registerProvider } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { createConfigRoute } from './config.js'

let dbHandle: DB | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

async function setup(cwd?: string) {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  const ctx = createServerContext({
    db,
    llmRegistry: createRegistry(),
    cwd: cwd ?? join(mkdtempSync(join(tmpdir(), 'c0de-test-'))),
  })
  const app = createConfigRoute(ctx)
  return { app, ctx }
}

describe('config route', () => {
  it('GET / returns current config', async () => {
    const { app } = await setup()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const config = (await res.json()) as Record<string, unknown>
    expect(config.defaultProvider).toBeDefined()
    expect(config.defaultModel).toBeDefined()
    expect(config.tools).toBeDefined()
  })

  it('PATCH / updates config (merge)', async () => {
    const { app, ctx } = await setup()
    const res = await app.request('/', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'gpt-5' }),
    })
    expect(res.status).toBe(200)
    const config = (await res.json()) as { defaultModel: string; defaultProvider: string }
    expect(config.defaultModel).toBe('gpt-5')
    expect(config.defaultProvider).toBeDefined()
    expect(ctx.config.defaultModel).toBe('gpt-5')
  })

  it('PATCH / deep merges nested objects', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tools: { enabled: ['read', 'write'] } }),
    })
    expect(res.status).toBe(200)
    const config = (await res.json()) as {
      tools: { enabled: string[]; disabled: string[] }
    }
    expect(config.tools.enabled).toEqual(['read', 'write'])
    expect(config.tools.disabled).toBeDefined()
  })

  it('PATCH / with providers syncs the llm registry live', async () => {
    const { app, ctx } = await setup()
    expect(ctx.llmRegistry.routes.has('myprov')).toBe(false)
    const res = await app.request('/', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providers: [
          {
            name: 'myprov',
            protocol: 'openai-compat',
            apiKey: 'sk-x',
            baseURL: 'https://example.com/v1',
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    // registry 原地同步：运行中 ServerContext 立即生效
    expect(ctx.llmRegistry.routes.has('myprov')).toBe(true)
  })

  it('registerProvider on registry is reachable (smoke)', () => {
    const r = createRegistry()
    registerProvider(r, { name: 'smoke', baseURL: 'https://x/v1', apiKey: 'k' })
    expect(r.routes.has('smoke')).toBe(true)
  })
})
