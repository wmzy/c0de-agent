// REST routes for the kanban board — frontend UI uses these for drag-and-drop
// card operations, board config, and initial load.
// P2-5：/deleted* 为看板回收站端点（必须注册在 /:projectId 之前避免被参数路由吞掉）。

import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import {
  createKanbanStore,
  getDeletedKanbanBoard,
  KanbanCardNotFoundError,
  KanbanColumnInUseError,
  KanbanColumnNotFoundError,
  KanbanInvalidPriorityError,
  listDeletedKanbanBoards,
  mergeKanbanBoard,
  permanentlyDeleteKanbanBoard,
  restoreKanbanBoard,
} from '../../kanban/index.js'
import { fromDirectory, getProject } from '../../project/index.js'
import type { KanbanColumnDef, KanbanLabelDef, KanbanPriority } from '../../shared/types/kanban.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

function createKanbanRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET /deleted — 回收站看板列表（项目删除软删除的看板，60 天保留期）。
  app.get('/deleted', async (c) => {
    return c.json({ boards: await listDeletedKanbanBoards(ctx.db) })
  })

  // POST /deleted/:boardId/restore — 恢复到指定项目，或「重建原项目」恢复。
  // P1 修复：merge=true 时目标已有看板不再 409——缺失列与卡片并入现有看板
  // （目标无板时等价普通恢复）。此前 409 指引「删除目标看板」但产品无此能力，
  // 恢复是死胡同。
  app.post('/deleted/:boardId/restore', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      projectId?: unknown
      rebuild?: unknown
      merge?: unknown
    }
    const boardId = c.req.param('boardId')
    const merge = body.merge === true

    // 重建原项目：目录仍存在时重建项目记录并恢复到该目录（与会话存储同语义）。
    if (body.rebuild === true) {
      const board = await getDeletedKanbanBoard(ctx.db, boardId)
      if (!board) return apiError(c, 404, 'BOARD_NOT_FOUND', '看板不存在或不在回收站')
      if (!board.deletedProjectWorktree) {
        return apiError(
          c,
          400,
          'NO_ORIGINAL_WORKTREE',
          '该看板未记录原项目目录，无法重建原项目；请改为恢复到现有项目',
        )
      }
      if (!existsSync(board.deletedProjectWorktree)) {
        return apiError(
          c,
          409,
          'ORIGINAL_DIR_MISSING',
          '原项目目录已不存在，无法重建；请改为恢复到现有项目',
        )
      }
      const project = await fromDirectory(ctx.db, board.deletedProjectWorktree)
      if (merge) {
        const result = await mergeKanbanBoard(ctx.db, boardId, project.id)
        if (result.ok) {
          return c.json({
            ok: true,
            merged: result,
            recreatedProject: { id: project.id, name: project.name },
          })
        }
        return apiError(c, 404, 'BOARD_NOT_FOUND', '看板不存在或不在回收站')
      }
      const result = await restoreKanbanBoard(ctx.db, boardId, project.id)
      if (result.ok) {
        return c.json({ ok: true, recreatedProject: { id: project.id, name: project.name } })
      }
      if (result.reason === 'TARGET_HAS_BOARD') {
        return apiError(c, 409, 'TARGET_HAS_BOARD', '原项目已存在看板，无法覆盖')
      }
      return apiError(c, 404, 'BOARD_NOT_FOUND', '看板不存在或不在回收站')
    }

    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : ''
    if (!projectId) return apiError(c, 400, 'PROJECT_REQUIRED', '恢复目标项目（projectId）必填')
    // P2 修复：目标项目必须存在（与会话恢复口径一致）——此前不校验，
    // 可恢复出挂在不存在项目下、任何视图都不可见的看板。
    const target = await getProject(ctx.db, projectId)
    if (!target) return apiError(c, 404, 'PROJECT_NOT_FOUND', '恢复目标项目不存在')
    if (merge) {
      const result = await mergeKanbanBoard(ctx.db, boardId, projectId)
      if (result.ok) return c.json({ ok: true, merged: result })
      return apiError(c, 404, 'BOARD_NOT_FOUND', '看板不存在或不在回收站')
    }
    const result = await restoreKanbanBoard(ctx.db, boardId, projectId)
    if (result.ok) return c.json({ ok: true })
    if (result.reason === 'TARGET_HAS_BOARD') {
      return apiError(c, 409, 'TARGET_HAS_BOARD', '目标项目已有看板，请先导出/删除目标看板后再恢复')
    }
    return apiError(c, 404, 'BOARD_NOT_FOUND', '看板不存在或不在回收站')
  })

  // DELETE /deleted/:boardId — 彻底删除回收站看板（不可恢复）。
  app.delete('/deleted/:boardId', async (c) => {
    const count = await permanentlyDeleteKanbanBoard(ctx.db, c.req.param('boardId'))
    if (count === 0) return apiError(c, 404, 'BOARD_NOT_FOUND', '看板不存在或不在回收站')
    return c.json({ ok: true })
  })

  // P1 修复：所有 /:projectId* 端点的项目存在守卫（注册在 /deleted* 之后）。
  // 此前不存在的项目会穿透到 getOrCreateBoardId 的 insert，FK violation 抛 500
  // 且错误信息回显 SQL——应为 404。
  const guardProject = async (
    c: import('hono').Context,
    next: () => Promise<void>,
  ): Promise<Response | undefined> => {
    const project = await getProject(ctx.db, c.req.param('projectId') ?? '')
    if (!project) return apiError(c, 404, 'PROJECT_NOT_FOUND', '项目不存在')
    await next()
  }
  app.use('/:projectId', guardProject)
  app.use('/:projectId/*', guardProject)

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
    try {
      const card = await store.addCard({
        title,
        description: (body.description as string) ?? null,
        columnId: body.columnId as string | undefined,
        priority: body.priority as KanbanPriority | undefined,
        labels: body.labels as string[] | undefined,
      })
      return c.json(card, 201)
    } catch (err) {
      if (err instanceof KanbanColumnNotFoundError) {
        return apiError(c, 400, 'KANBAN_COLUMN_NOT_FOUND', err.message)
      }
      if (err instanceof KanbanInvalidPriorityError) {
        return apiError(c, 400, 'INVALID_PRIORITY', err.message)
      }
      throw err
    }
  })

  // PATCH /:projectId/cards/:cardId — update card fields or move
  app.patch('/:projectId/cards/:cardId', async (c) => {
    const projectId = c.req.param('projectId')
    const cardId = c.req.param('cardId')
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const store = createKanbanStore(ctx.db, projectId)

    try {
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
    } catch (err) {
      if (err instanceof KanbanCardNotFoundError) {
        return apiError(c, 404, 'CARD_NOT_FOUND', err.message)
      }
      if (err instanceof KanbanColumnNotFoundError) {
        return apiError(c, 400, 'KANBAN_COLUMN_NOT_FOUND', err.message)
      }
      if (err instanceof KanbanInvalidPriorityError) {
        return apiError(c, 400, 'INVALID_PRIORITY', err.message)
      }
      throw err
    }
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
