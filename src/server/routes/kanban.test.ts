// src/server/routes/kanban.test.ts
// 看板 REST 路由 body 字段类型校验回归：畸形 JSON 此前直接 as 断言后进入
// store/DB——title 数字 → .trim TypeError 500、columns/labels 数组含 null
// 或缺字段 → 读 null.id TypeError 500、labels 字符串 → 持久化毒化卡片。

import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { projects } from '../../db/schema.js'
import { createServerContext } from '../context.js'
import { createKanbanRoute } from './kanban.js'

let dbHandle: DB | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

const PROJECT_ID = 'kanban-validation-project'

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  await db.db.insert(projects).values({ id: PROJECT_ID, worktree: '/tmp/kanban-validation' })
  const ctx = createServerContext({ db, llmRegistry: {} as never })
  const app = createKanbanRoute(ctx)
  return { app, db }
}

function post(path: string, body: unknown) {
  return new Request(`http://x/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('kanban route body validation', () => {
  it('POST cards：title 非字符串 → 400（而非 .trim TypeError 500）', async () => {
    const { app } = await setup()
    const res = await app.request(post(`${PROJECT_ID}/cards`, { title: 42 }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('INVALID_INPUT')
  })

  it('POST cards：labels 非数组 → 400（而非持久化毒化卡片）', async () => {
    const { app } = await setup()
    const res = await app.request(
      post(`${PROJECT_ID}/cards`, { title: 'ok', labels: 'not-an-array' }),
    )
    expect(res.status).toBe(400)
    // 板未被毒化：后续正常建卡仍可用
    const ok = await app.request(post(`${PROJECT_ID}/cards`, { title: 'fine' }))
    expect(ok.status).toBe(201)
  })

  it('POST cards：labels 数组含非字符串 → 400', async () => {
    const { app } = await setup()
    const res = await app.request(post(`${PROJECT_ID}/cards`, { title: 'ok', labels: [42] }))
    expect(res.status).toBe(400)
  })

  it('POST cards：description 非字符串/null → 400', async () => {
    const { app } = await setup()
    const res = await app.request(post(`${PROJECT_ID}/cards`, { title: 'ok', description: 42 }))
    expect(res.status).toBe(400)
  })

  it('POST cards：priority 非法值 → 400', async () => {
    const { app } = await setup()
    const res = await app.request(post(`${PROJECT_ID}/cards`, { title: 'ok', priority: 'urgent' }))
    expect(res.status).toBe(400)
  })

  it('PATCH card：title 非字符串 → 400（而非把数字写入 title 列 500）', async () => {
    const { app } = await setup()
    const created = await app.request(post(`${PROJECT_ID}/cards`, { title: 'base' }))
    const card = (await created.json()) as { id: string }
    const res = await app.request(
      new Request(`http://x/${PROJECT_ID}/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 42 }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('PATCH card：labels 非数组 → 400', async () => {
    const { app } = await setup()
    const created = await app.request(post(`${PROJECT_ID}/cards`, { title: 'base' }))
    const card = (await created.json()) as { id: string }
    const res = await app.request(
      new Request(`http://x/${PROJECT_ID}/cards/${card.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: 'x' }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('PATCH board：columns 非数组 → 400（而非 .map TypeError 500）', async () => {
    const { app } = await setup()
    const res = await app.request(
      new Request(`http://x/${PROJECT_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns: 42 }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('PATCH board：columns 数组含 null → 400（而非读 null.id TypeError 500）', async () => {
    const { app } = await setup()
    const res = await app.request(
      new Request(`http://x/${PROJECT_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns: [null] }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('PATCH board：columns 条目缺 name → 400（而非持久化缺字段列）', async () => {
    const { app } = await setup()
    const res = await app.request(
      new Request(`http://x/${PROJECT_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns: [{ id: 'a' }] }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('PATCH board：columns 含重复 id → 400', async () => {
    const { app } = await setup()
    const res = await app.request(
      new Request(`http://x/${PROJECT_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          columns: [
            { id: 'a', name: 'A' },
            { id: 'a', name: 'A2' },
          ],
        }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('PATCH board：labels 数组含 null → 400', async () => {
    const { app } = await setup()
    const res = await app.request(
      new Request(`http://x/${PROJECT_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: [null] }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('import：columns 数组含 null → 400（而非读 null.id TypeError 500）', async () => {
    const { app } = await setup()
    const res = await app.request(
      post(`${PROJECT_ID}/import`, { version: 1, columns: [null], cards: [] }),
    )
    expect(res.status).toBe(400)
  })

  it('import：columns 条目缺 name → 400', async () => {
    const { app } = await setup()
    const res = await app.request(
      post(`${PROJECT_ID}/import`, { version: 1, columns: [{ id: 'a' }], cards: [] }),
    )
    expect(res.status).toBe(400)
  })

  it('import：labels 数组含 null → 400', async () => {
    const { app } = await setup()
    const res = await app.request(
      post(`${PROJECT_ID}/import`, {
        version: 1,
        columns: [{ id: 'todo', name: '待办' }],
        labels: [null],
        cards: [],
      }),
    )
    expect(res.status).toBe(400)
  })

  it('import：columns 含重复 id → 400', async () => {
    const { app } = await setup()
    const res = await app.request(
      post(`${PROJECT_ID}/import`, {
        version: 1,
        columns: [
          { id: 'a', name: 'A' },
          { id: 'a', name: 'A2' },
        ],
        cards: [],
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('kanban 写端点 body 形状校验（null/非对象 body）', () => {
  it.each(['null', '[]', '"text"', '{broken'])(
    'PATCH /:projectId body=%s → 400（此前 null body 在 body.columns 处 500）',
    async (raw) => {
      const { app } = await setup()
      const res = await app.request(`${PROJECT_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      })
      expect(res.status).toBe(400)
    },
  )

  it('POST /:projectId/cards null body → 400', async () => {
    const { app } = await setup()
    const res = await app.request(`${PROJECT_ID}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    })
    expect(res.status).toBe(400)
  })

  it('PATCH /:projectId/cards/:cardId null body → 400', async () => {
    const { app } = await setup()
    const res = await app.request(`${PROJECT_ID}/cards/00000000-0000-0000-0000-000000000000`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    })
    expect(res.status).toBe(400)
  })

  it('POST /deleted/:boardId/restore null body → 400', async () => {
    const { app } = await setup()
    const res = await app.request('deleted/00000000-0000-0000-0000-000000000000/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    })
    expect(res.status).toBe(400)
  })
})

describe('kanban 路径参数 id 格式校验', () => {
  it('DELETE /deleted/:boardId 非 UUID → 404（此前 PG 22P02 击穿 500）', async () => {
    const { app } = await setup()
    const res = await app.request('deleted/not-a-uuid', { method: 'DELETE' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('BOARD_NOT_FOUND')
  })

  it('POST /deleted/:boardId/restore 非 UUID → 404', async () => {
    const { app } = await setup()
    const res = await app.request(post('deleted/not-a-uuid/restore', { projectId: PROJECT_ID }))
    expect(res.status).toBe(404)
  })

  it('PATCH /:projectId/cards/:cardId 非 UUID → 404（看板存在时此前 500）', async () => {
    const { app } = await setup()
    // 先建板（GET /:projectId 懒建），使 store 真正走到 uuid 列查询
    await app.request(`${PROJECT_ID}`)
    const res = await app.request(`${PROJECT_ID}/cards/not-a-uuid`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('CARD_NOT_FOUND')
  })

  it('DELETE /:projectId/cards/:cardId 非 UUID → 404（看板存在时此前 500）', async () => {
    const { app } = await setup()
    await app.request(`${PROJECT_ID}`)
    const res = await app.request(`${PROJECT_ID}/cards/not-a-uuid`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
