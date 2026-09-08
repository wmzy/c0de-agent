// REST routes for the kanban board — frontend UI uses these for drag-and-drop
// card operations, board config, and initial load.
import { Hono } from 'hono'
import { createKanbanStore, KanbanColumnInUseError } from '../../kanban/index.js'
import type { KanbanColumnDef, KanbanLabelDef, KanbanPriority } from '../../shared/types/kanban.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

function createKanbanRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET /:projectId — full board with cards
  app.get('/:projectId', async (c) => {
    const projectId = c.req.param('projectId')
    const store = createKanbanStore(ctx.db, projectId)
    const board = await store.getBoard()
    return c.json(board)
  })

  // GET /:projectId/export — 看板 JSON 导出（项目删除会永久级联删除看板，
  // 会话有 60 天回收站而看板没有——导出是唯一的备份途径）。
  app.get('/:projectId/export', async (c) => {
    const projectId = c.req.param('projectId')
    const store = createKanbanStore(ctx.db, projectId)
    const board = await store.getBoard()
    return c.json({
      version: 1,
      exportedAt: new Date().toISOString(),
      projectId,
      columns: board.columns,
      labels: board.labels,
      cards: board.cards.map(
        ({ id: _id, boardId: _b, createdAt: _c, updatedAt: _u, ...card }) => card,
      ),
    })
  })

  // POST /:projectId/import — 导入/替换整板（列+标签+卡片原子重建）。
  app.post('/:projectId/import', async (c) => {
    const projectId = c.req.param('projectId')
    const body = (await c.req.json().catch(() => null)) as {
      version?: unknown
      columns?: unknown
      labels?: unknown
      cards?: unknown
    } | null
    if (body?.version !== 1 || !Array.isArray(body.columns) || !Array.isArray(body.cards)) {
      return apiError(
        c,
        400,
        'INVALID_EXPORT',
        '无效的看板导出 JSON：需要 version/columns/cards 字段',
      )
    }
    const columns = body.columns as KanbanColumnDef[]
    const labels = Array.isArray(body.labels) ? (body.labels as KanbanLabelDef[]) : []
    // 宽松校验卡片：只保留结构完整的条目（导入宁少勿坏，与会话导入一致）。
    const cards = (body.cards as Array<Record<string, unknown>>)
      .filter(
        (card) =>
          card !== null &&
          typeof card === 'object' &&
          typeof card.title === 'string' &&
          card.title.length > 0 &&
          typeof card.columnId === 'string' &&
          typeof card.priority === 'string',
      )
      .map((card) => ({
        title: card.title as string,
        description: typeof card.description === 'string' ? card.description : null,
        columnId: card.columnId as string,
        priority: (card.priority === 'high' || card.priority === 'medium' || card.priority === 'low'
          ? card.priority
          : 'medium') as KanbanPriority,
        position: typeof card.position === 'number' ? card.position : 0,
        labels: Array.isArray(card.labels)
          ? (card.labels as string[]).filter((l): l is string => typeof l === 'string')
          : [],
      }))
    // 卡片只能落在导入的列上——悬空列会导致卡片静默不可见（与列删除保护同理）。
    const columnIds = new Set(columns.map((col) => col.id))
    const orphanCards = cards.filter((card) => !columnIds.has(card.columnId))
    if (orphanCards.length > 0) {
      return apiError(
        c,
        400,
        'INVALID_CARDS',
        `${orphanCards.length} 张卡片引用了不存在的列（${[...new Set(orphanCards.map((x) => x.columnId))].join(', ')}）`,
      )
    }
    const store = createKanbanStore(ctx.db, projectId)
    const board = await store.replaceBoard({ columns, labels, cards })
    return c.json({ ok: true, cardCount: board.cards.length })
  })

  // PATCH /:projectId — update board columns/labels config
  app.patch('/:projectId', async (c) => {
    const projectId = c.req.param('projectId')
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const store = createKanbanStore(ctx.db, projectId)
    try {
      const board = await store.updateBoard({
        ...(body.columns !== undefined && { columns: body.columns as KanbanColumnDef[] }),
        ...(body.labels !== undefined && { labels: body.labels as KanbanLabelDef[] }),
      })
      return c.json(board)
    } catch (err) {
      if (err instanceof KanbanColumnInUseError) {
        return apiError(c, 409, 'KANBAN_COLUMN_IN_USE', err.message)
      }
      throw err
    }
  })

  // POST /:projectId/cards — add a card
  app.post('/:projectId/cards', async (c) => {
    const projectId = c.req.param('projectId')
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const title = (body.title as string)?.trim()
    if (!title) return apiError(c, 400, 'INVALID_INPUT', 'title is required')
    const store = createKanbanStore(ctx.db, projectId)
    const card = await store.addCard({
      title,
      description: (body.description as string) ?? null,
      columnId: body.columnId as string | undefined,
      priority: body.priority as KanbanPriority | undefined,
      labels: body.labels as string[] | undefined,
    })
    return c.json(card, 201)
  })

  // PATCH /:projectId/cards/:cardId — update card fields or move
  app.patch('/:projectId/cards/:cardId', async (c) => {
    const projectId = c.req.param('projectId')
    const cardId = c.req.param('cardId')
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const store = createKanbanStore(ctx.db, projectId)

    // columnId + position → moveCard; otherwise field update.
    if (body.columnId !== undefined) {
      const card = await store.moveCard(
        cardId,
        body.columnId as string,
        body.position as number | undefined,
      )
      return c.json(card)
    }

    const card = await store.updateCard(cardId, {
      ...(body.title !== undefined && { title: body.title as string }),
      ...(body.description !== undefined && {
        description: body.description as string | null,
      }),
      ...(body.priority !== undefined && { priority: body.priority as KanbanPriority }),
      ...(body.labels !== undefined && { labels: body.labels as string[] }),
    })
    return c.json(card)
  })

  // DELETE /:projectId/cards/:cardId — delete a card
  app.delete('/:projectId/cards/:cardId', async (c) => {
    const projectId = c.req.param('projectId')
    const cardId = c.req.param('cardId')
    const store = createKanbanStore(ctx.db, projectId)
    await store.deleteCard(cardId)
    return c.json({ ok: true })
  })

  return app
}

export { createKanbanRoute }
