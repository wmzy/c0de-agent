import { describe, expect, it } from 'vitest'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import type { APIErrorBody } from '../types.js'
import { createToolRoute } from './tool.js'

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  await migrateDB(db)
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

  it('POST /confirm without active run returns 404', async () => {
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
    const pendingMap = new Map<string, (approved: boolean) => void>()
    const mockChecker = {
      check: async () => ({ _tag: 'allow' as const }),
      confirm: (id: string, approved: boolean) => {
        const r = pendingMap.get(id)
        if (!r) return false
        pendingMap.delete(id)
        r(approved)
        return true
      },
      hasPending: (id: string) => pendingMap.has(id),
      pendingCount: () => pendingMap.size,
    }
    pendingMap.set('tc-test', (_approved) => {
      // no-op
    })
    ctx.agentManager.register({
      sessionId: 's1',
      state: {
        id: 'a1',
        session: {
          id: 's1',
          title: 'T',
          parentId: null,
          branchPoint: null,
          metadata: {},
          createdAt: 0,
          updatedAt: 0,
        },
        messages: [],
        tools: [],
        config: { provider: 'p', model: 'm', tools: [], plugins: [] },
        status: { _tag: 'running', turnCount: 0 },
        abortController: new AbortController(),
        steeringQueue: [],
        llmDetails: [],
        tokenBudget: { total: 0, reserved: 0, available: 0, used: 0, keepRecent: 0 },
      },
      deps: {} as never,
      permissionChecker: mockChecker as never,
    })

    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tc-test', approved: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { confirmed: boolean }
    expect(body.confirmed).toBe(true)
  })
})
