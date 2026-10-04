import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createTestDB, resetTestDB } from '../../db/test-utils.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import type { APIErrorBody } from '../types.js'
import { createToolRoute } from './tool.js'

let dbHandle: DB
beforeAll(async () => {
  dbHandle = await createTestDB()
})
afterAll(async () => {
  await dbHandle.close()
})
afterEach(async () => {
  await resetTestDB(dbHandle)
})

async function setup() {
  const db = dbHandle
  const ctx = createServerContext({ db, llmRegistry: createRegistry() })
  const app = createToolRoute(ctx)
  return { app, ctx }
}

describe('tool route', () => {
  it('GET / lists available tools', async () => {
    const { app } = await setup()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const tools = (await res.json()) as Array<{ name: string }>
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
    const names = tools.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).toContain('bash')
  })

  it('GET / tools contain name, description, parameters, permission', async () => {
    const { app } = await setup()
    const res = await app.request('/')
    const tools = (await res.json()) as Array<{
      name: string
      description: string
      parameters: unknown
      permission: string
      execute?: unknown
    }>
    const readTool = tools.find((t) => t.name === 'read')
    expect(readTool).toBeDefined()
    expect(readTool?.description).toBeDefined()
    expect(readTool?.parameters).toBeDefined()
    expect(readTool?.permission).toBeDefined()
    expect(readTool?.execute).toBeUndefined()
  })

  it('POST /confirm without pending permission returns 404', async () => {
    const { app } = await setup()
    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tc1', approved: true }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as APIErrorBody
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('POST /confirm confirms permission', async () => {
    const { app, ctx } = await setup()
    let resolved = false
    ctx.permissionStore.register('tc-test', {
      request: { toolCallId: 'tc-test', tool: 'bash', input: { command: 'echo test' } },
      resolve: () => {
        resolved = true
      },
    })

    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tc-test', approved: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { confirmed: boolean }
    expect(body.confirmed).toBe(true)
    expect(resolved).toBe(true)
  })

  it('POST /confirm 畸形 JSON body → 400 而非 500', async () => {
    const { app } = await setup()
    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    })
    expect(res.status).toBe(400)
  })

  it('POST /confirm null body → 400 而非 500', async () => {
    const { app } = await setup()
    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    })
    expect(res.status).toBe(400)
  })

  it('POST /confirm 非字符串 toolCallId → 400', async () => {
    const { app } = await setup()
    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId: 42, approved: true }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /confirm 非布尔 approved 按拒绝处理（"false" 字符串不得放行）', async () => {
    const { app, ctx } = await setup()
    const resolutions: unknown[] = []
    ctx.permissionStore.register('tc-str', {
      request: { toolCallId: 'tc-str', tool: 'bash', input: { command: 'rm -rf /' } },
      resolve: (r) => {
        resolutions.push(r)
      },
    })
    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tc-str', approved: 'false' }),
    })
    expect(res.status).toBe(200)
    expect(resolutions).toEqual([{ _tag: 'deny', reason: 'User denied permission' }])
  })
})
