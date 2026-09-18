// src/server/routes/kanban-export.test.ts
// P0 审查修复：看板导出/导入端点测试（项目删除会永久级联删除看板，导出是唯一备份途径）。

import { eq } from 'drizzle-orm'
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
  it('P2：恢复到不存在的项目 → 404 PROJECT_NOT_FOUND（与会话恢复口径一致）', async () => {
    const { app, db } = await setup()
    await seedCard(app)
    const { softDeleteKanbanBoard } = await import('../../kanban/index.js')
    const boards = await db.db.query.kanbanBoards.findMany()
    const boardId = boards[0]?.id
    if (!boardId) throw new Error('board not seeded')
    await softDeleteKanbanBoard(db, PROJECT_ID, null)

    const res = await app.request(`/deleted/${boardId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'nonexistent-project' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('PROJECT_NOT_FOUND')
  })
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

describe('kanban route guards', () => {
  it('GET 不存在项目的看板 → 404 PROJECT_NOT_FOUND（此前 FK violation 500）', async () => {
    const { app } = await setup()
    const res = await app.request('/ghost-project')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('PROJECT_NOT_FOUND')
    // 不泄漏 SQL/FK 内部信息
    expect(JSON.stringify(body)).not.toContain('insert into')
  })

  it('POST 不存在项目的卡片 → 404', async () => {
    const { app } = await setup()
    const res = await app.request('/ghost-project/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('addCard 悬空列 → 400 KANBAN_COLUMN_NOT_FOUND（含可用列提示）', async () => {
    const { app } = await setup()
    const res = await app.request(`/${PROJECT_ID}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ghost', columnId: 'nowhere' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('KANBAN_COLUMN_NOT_FOUND')
    expect(body.error?.message).toContain('可用列')
    // 卡片未落库
    const boardRes = await app.request(`/${PROJECT_ID}`)
    const board = (await boardRes.json()) as { cards: unknown[] }
    expect(board.cards).toHaveLength(0)
  })

  it('addCard 非法优先级 → 400 INVALID_PRIORITY', async () => {
    const { app } = await setup()
    const res = await app.request(`/${PROJECT_ID}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', priority: 'urgent' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('INVALID_PRIORITY')
  })

  it('PATCH 移动卡片到悬空列 → 400；卡片留在原列', async () => {
    const { app } = await setup()
    const card = await seedCard(app)
    const res = await app.request(`/${PROJECT_ID}/cards/${card.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId: 'nowhere' }),
    })
    expect(res.status).toBe(400)
    const boardRes = await app.request(`/${PROJECT_ID}`)
    const board = (await boardRes.json()) as { cards: Array<{ id: string; columnId: string }> }
    expect(board.cards[0]?.columnId).toBe('todo')
  })

  it('PATCH 不存在的卡片 → 404 CARD_NOT_FOUND（此前 500）', async () => {
    const { app } = await setup()
    await seedCard(app)
    const res = await app.request(`/${PROJECT_ID}/cards/00000000-0000-0000-0000-000000000000`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'nope' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('CARD_NOT_FOUND')
  })

  it('restore merge=true 目标已有看板 → 200 合并（不再 409 死胡同）', async () => {
    const { app, db } = await setup()
    await seedCard(app)
    const boards = await db.db.query.kanbanBoards.findMany()
    const boardId = boards[0]?.id
    if (!boardId) throw new Error('board not seeded')
    const { softDeleteKanbanBoard } = await import('../../kanban/index.js')
    await softDeleteKanbanBoard(db, PROJECT_ID, null)
    await db.db.delete(projects).where(eq(projects.id, PROJECT_ID))

    // 另一个项目已有看板 + 卡片
    await db.db.insert(projects).values({ id: 'target-project', worktree: '/tmp/target' })
    const targetSeed = await app.request('/target-project/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'dst-card', columnId: 'todo' }),
    })
    expect(targetSeed.status).toBe(201)

    const res = await app.request(`/deleted/${boardId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'target-project', merge: true }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; merged?: { mergedCards: number } }
    expect(body.ok).toBe(true)
    expect(body.merged?.mergedCards).toBe(1)

    // 合并后目标板含两张卡片；源看板已不在回收站
    const boardRes = await app.request('/target-project')
    const board = (await boardRes.json()) as { cards: Array<{ title: string }> }
    expect(board.cards.map((c) => c.title).sort()).toEqual(['Card A', 'dst-card'])
    const deletedRes = await app.request('/deleted')
    const deleted = (await deletedRes.json()) as { boards: unknown[] }
    expect(deleted.boards).toHaveLength(0)
  })

  it('restore merge=true 目标无看板 → 等价恢复', async () => {
    const { app, db } = await setup()
    await seedCard(app)
    const boards = await db.db.query.kanbanBoards.findMany()
    const boardId = boards[0]?.id
    if (!boardId) throw new Error('board not seeded')
    const { softDeleteKanbanBoard } = await import('../../kanban/index.js')
    await softDeleteKanbanBoard(db, PROJECT_ID, null)
    await db.db.delete(projects).where(eq(projects.id, PROJECT_ID))
    await db.db.insert(projects).values({ id: 'target-project', worktree: '/tmp/target' })

    const res = await app.request(`/deleted/${boardId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'target-project', merge: true }),
    })
    expect(res.status).toBe(200)
    const boardRes = await app.request('/target-project')
    const board = (await boardRes.json()) as { cards: Array<{ title: string }> }
    expect(board.cards.map((c) => c.title)).toEqual(['Card A'])
  })
})
