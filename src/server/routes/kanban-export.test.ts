// src/server/routes/kanban-export.test.ts
// P0 审查修复：看板导出/导入端点测试（项目删除会永久级联删除看板，导出是唯一备份途径）。

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

const PROJECT_ID = 'kanban-io-project'

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  await db.db.insert(projects).values({ id: PROJECT_ID, worktree: '/tmp/kanban-io' })
  const ctx = createServerContext({ db, llmRegistry: {} as never })
  const app = createKanbanRoute(ctx)
  return { app, db }
}

/** 经 REST 建一张卡片（同时 lazy 建板）。 */
async function seedCard(app: ReturnType<typeof createKanbanRoute>) {
  const res = await app.request(`/${PROJECT_ID}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Card A', columnId: 'todo', priority: 'high' }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

describe('kanban export/import', () => {
  it('导出包含 version/projectId/columns/labels/cards，且卡片不含内部字段', async () => {
    const { app } = await setup()
    await seedCard(app)
    const res = await app.request(`/${PROJECT_ID}/export`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.version).toBe(1)
    expect(body.projectId).toBe(PROJECT_ID)
    expect(Array.isArray(body.columns)).toBe(true)
    expect(Array.isArray(body.labels)).toBe(true)
    const cards = body.cards as Array<Record<string, unknown>>
    expect(cards).toHaveLength(1)
    expect(cards[0]?.title).toBe('Card A')
    expect(cards[0]?.priority).toBe('high')
    // 内部字段（id/boardId/时间戳）不随导出
    expect(cards[0]?.id).toBeUndefined()
    expect(cards[0]?.boardId).toBeUndefined()
    expect(cards[0]?.createdAt).toBeUndefined()
  })

  it('导出 JSON 重新导入 → 整板原子替换（列+卡片）', async () => {
    const { app } = await setup()
    await seedCard(app)
    const exportRes = await app.request(`/${PROJECT_ID}/export`)
    const exported = (await exportRes.json()) as Record<string, unknown>

    // 修改导出数据：加一列、改卡片标题，模拟备份恢复
    const modified = {
      ...exported,
      columns: [...(exported.columns as unknown[]), { id: 'backlog', name: '积压' }],
      cards: [
        { title: 'Restored Card', columnId: 'todo', priority: 'low', position: 1000, labels: [] },
      ],
    }
    const importRes = await app.request(`/${PROJECT_ID}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(modified),
    })
    expect(importRes.status).toBe(200)
    const body = (await importRes.json()) as { ok: boolean; cardCount: number }
    expect(body.ok).toBe(true)
    expect(body.cardCount).toBe(1)

    const getRes = await app.request(`/${PROJECT_ID}`)
    const board = (await getRes.json()) as {
      columns: Array<{ id: string }>
      cards: Array<{ title: string }>
    }
    expect(board.columns.some((c) => c.id === 'backlog')).toBe(true)
    expect(board.cards).toHaveLength(1)
    expect(board.cards[0]?.title).toBe('Restored Card')
  })

  it('无效载荷 → 400 INVALID_EXPORT', async () => {
    const { app } = await setup()
    const res = await app.request(`/${PROJECT_ID}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('INVALID_EXPORT')
  })

  it('卡片引用不存在的列 → 400 INVALID_CARDS（防卡片静默不可见）', async () => {
    const { app } = await setup()
    const res = await app.request(`/${PROJECT_ID}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        columns: [{ id: 'todo', name: '待办' }],
        labels: [],
        cards: [
          { title: 'Ghost', columnId: 'nowhere', priority: 'medium', position: 0, labels: [] },
        ],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('INVALID_CARDS')
  })

  it('结构不完整的卡片被过滤（宁少勿坏），合法卡片保留', async () => {
    const { app } = await setup()
    const res = await app.request(`/${PROJECT_ID}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        columns: [{ id: 'todo', name: '待办' }],
        labels: [],
        cards: [
          { title: 'Good', columnId: 'todo', priority: 'high', position: 0, labels: [] },
          { title: '', columnId: 'todo', priority: 'medium', position: 10, labels: [] },
          { columnId: 'todo', priority: 'medium', position: 20, labels: [] },
          'junk',
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cardCount: number }
    expect(body.cardCount).toBe(1)
  })
})
