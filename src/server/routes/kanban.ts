// REST routes for the kanban board — frontend UI uses these for drag-and-drop
// card operations, board config, and initial load.
import { Hono } from 'hono'
import { createKanbanStore } from '../../kanban/index.js'
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

  // PATCH /:projectId — update board columns/labels config
  app.patch('/:projectId', async (c) => {
    const projectId = c.req.param('projectId')
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const store = createKanbanStore(ctx.db, projectId)
    const board = await store.updateBoard({
      ...(body.columns !== undefined && { columns: body.columns as KanbanColumnDef[] }),
      ...(body.labels !== undefined && { labels: body.labels as KanbanLabelDef[] }),
    })
    return c.json(board)
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
