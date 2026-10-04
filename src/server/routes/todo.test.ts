// todo REST 路由测试（UI 手动操作入口 POST /:sessionId）。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { projects } from '../../db/schema.js'
import { createTestDB, resetTestDB } from '../../db/test-utils.js'
import { createRegistry } from '../../llm/registry.js'
import { createSession } from '../../session/session.js'
import { createServerContext } from '../context.js'
import { createTodoRoute } from './todo.js'

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

const TEST_PROJECT = 'todo-route-project'

async function setup() {
  const db = dbHandle
  await db.db.insert(projects).values({ id: TEST_PROJECT, worktree: '/tmp/todo-route' })
  const ctx = createServerContext({ db, llmRegistry: createRegistry() })
  const app = createTodoRoute(ctx)
  const session = await createSession(db, 'Todo Session', TEST_PROJECT, undefined, 'web')
  return { app, ctx, db, sessionId: session.id }
}

describe('todo route', () => {
  it('POST 合法 init 生效并返回 phases', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request(`/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'init', list: [{ phase: 'A', items: ['task x'] }] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { phases: Array<{ name: string }> }
    expect(body.phases[0]?.name).toBe('A')
  })

  it('POST 畸形 init（list 非数组）→ 400 而非 500', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request(`/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'init', list: 'oops' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('INVALID_TODO_INPUT')
  })

  it('POST 畸形 init（items 含非字符串）→ 400，不持久化毒化状态', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request(`/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'init', items: [123] }),
    })
    expect(res.status).toBe(400)
    // 未被持久化：GET 仍为空列表
    const getRes = await app.request(`/${sessionId}`)
    const body = (await getRes.json()) as { phases: unknown[] }
    expect(body.phases).toEqual([])
  })
})

describe('todo 路径参数 sessionId 格式校验', () => {
  it('GET /:sessionId 非 UUID → 404（此前 PG 22P02 击穿 500）', async () => {
    const { app } = await setup()
    const res = await app.request('/not-a-uuid')
    expect(res.status).toBe(404)
  })

  it('POST /:sessionId 非 UUID → 404', async () => {
    const { app } = await setup()
    const res = await app.request('/not-a-uuid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'view' }),
    })
    expect(res.status).toBe(404)
  })
})
