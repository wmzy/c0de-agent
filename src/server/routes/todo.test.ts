// todo REST 路由测试（UI 手动操作入口 POST /:sessionId）。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { projects } from '../../db/schema.js'
import { createTestDB, resetTestDB } from '../../db/test-utils.js'
import { createRegistry } from '../../llm/registry.js'
import { getMessages } from '../../session/message.js'
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

  // 前端 normalizeParts 按 id 把 tool_call 与 tool_result 配成一块；两个 id 不一致时
  // 时间线上会出现「永远停在运行中（⏳）」的 todo 块（并因拿不到 output 而谎报
  // 「Todo list is empty.」）外加一张孤立的 result 卡。实测从看板/待办面板点「添加」
  // 后必现。
  it('UI 手动操作持久化的 tool_call 与 tool_result 共用同一 id', async () => {
    const { app, db, sessionId } = await setup()
    const res = await app.request(`/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'append', phase: 'Tasks', items: ['写文档'] }),
    })
    expect(res.status).toBe(200)

    const parts = (await getMessages(db, sessionId)).flatMap((m) => m.content)
    const call = parts.find(
      (p): p is Extract<typeof p, { _tag: 'tool_call' }> =>
        p._tag === 'tool_call' && 'tool' in p && p.tool === 'todo',
    )
    const result = parts.find(
      (p): p is Extract<typeof p, { _tag: 'tool_result' }> =>
        p._tag === 'tool_result' && 'tool' in p && p.tool === 'todo',
    )
    expect(call).toBeDefined()
    expect(result).toBeDefined()
    expect(result?.id).toBe(call?.id)
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
