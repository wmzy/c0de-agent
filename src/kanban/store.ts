import { and, asc, eq, inArray, isNotNull, isNull, lt, max, sql } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { kanbanBoards, kanbanCards } from '../db/schema.js'
import type {
  KanbanBoard,
  KanbanBoardWithCards,
  KanbanCard,
  KanbanColumnDef,
  KanbanLabelDef,
  KanbanPriority,
  KanbanStore,
} from '../shared/types/kanban.js'
import { DEFAULT_KANBAN_COLUMNS } from '../shared/types/kanban.js'

type BoardRow = typeof kanbanBoards.$inferSelect
type CardRow = typeof kanbanCards.$inferSelect

/** Default column when none is specified. */
const DEFAULT_COLUMN_ID = 'todo'
/** Position increment — large gap avoids frequent re-indexing on reorder. */
const POSITION_GAP = 1000

/** 列内仍有卡片时禁止删除该列（否则卡片静默不可见）。 */
class KanbanColumnInUseError extends Error {
  constructor(columnNames: string[], cardCount: number) {
    super(
      `列 [${columnNames.join(', ')}] 中仍有 ${cardCount} 张卡片，无法删除。` +
        '请先移动或删除这些卡片。',
    )
  }
}

// ── Row → API mappers ──────────────────────────────────────

function rowToBoard(row: BoardRow): KanbanBoard {
  return {
    id: row.id,
    projectId: row.projectId,
    columns: row.columns as KanbanColumnDef[],
    labels: row.labels as KanbanLabelDef[],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function rowToCard(row: CardRow): KanbanCard {
  return {
    id: row.id,
    boardId: row.boardId,
    title: row.title,
    description: row.description,
    columnId: row.columnId,
    priority: row.priority as KanbanPriority,
    position: row.position,
    labels: row.labels as string[],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ── Factory ────────────────────────────────────────────────

/**
 * Create a project-scoped KanbanStore backed by the given db handle.
 * The board is created on first access (lazy) with the default 5 columns.
 */
function createKanbanStore(handle: DB, projectId: string): KanbanStore {
  const db = handle.db
  /** Insert a default board if none exists (idempotent via unique projectId). */
  async function getOrCreateBoardId(): Promise<string> {
    await db
      .insert(kanbanBoards)
      .values({
        projectId,
        columns: [...DEFAULT_KANBAN_COLUMNS] as KanbanColumnDef[],
        labels: [],
      })
      .onConflictDoNothing({ target: kanbanBoards.projectId })

    const [row] = await db
      .select({ id: kanbanBoards.id })
      .from(kanbanBoards)
      .where(and(eq(kanbanBoards.projectId, projectId), isNull(kanbanBoards.deletedAt)))
      .limit(1)
    // 行一定存在：上面 insert + onConflictDoNothing 保证了 projectId 对应的行已创建
    return (row as { id: string }).id
  }

  /** Max position in a column (0 if empty). */
  async function maxPos(boardId: string, columnId: string): Promise<number> {
    const [row] = await db
      .select({ m: max(kanbanCards.position) })
      .from(kanbanCards)
      .where(and(eq(kanbanCards.boardId, boardId), eq(kanbanCards.columnId, columnId)))
    return row?.m ?? 0
  }

  return {
    async getBoard(): Promise<KanbanBoardWithCards> {
      const boardId = await getOrCreateBoardId()
      const [boardRow] = await db
        .select()
        .from(kanbanBoards)
        .where(eq(kanbanBoards.id, boardId))
        .limit(1)
      const board = boardRow as BoardRow
      const cards = await db
        .select()
        .from(kanbanCards)
        .where(eq(kanbanCards.boardId, boardId))
        .orderBy(asc(kanbanCards.columnId), asc(kanbanCards.position))
      return { ...rowToBoard(board), cards: cards.map(rowToCard) }
    },

    async addCard(input): Promise<KanbanCard> {
      const boardId = await getOrCreateBoardId()
      const columnId = input.columnId ?? DEFAULT_COLUMN_ID
      const position = (await maxPos(boardId, columnId)) + POSITION_GAP
      const [cardRow] = await db
        .insert(kanbanCards)
        .values({
          boardId,
          title: input.title,
          description: input.description ?? null,
          columnId,
          priority: input.priority ?? 'medium',
          position,
          labels: input.labels ?? [],
        })
        .returning()
      const row = cardRow as CardRow
      return rowToCard(row)
    },

    async updateCard(id, patch): Promise<KanbanCard> {
      const [row] = await db
        .update(kanbanCards)
        .set({
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.priority !== undefined && { priority: patch.priority }),
          ...(patch.labels !== undefined && { labels: patch.labels }),
          updatedAt: new Date(),
        })
        .where(eq(kanbanCards.id, id))
        .returning()
      if (!row) throw new Error(`Kanban card not found: ${id}`)
      return rowToCard(row)
    },

    async moveCard(id, columnId, position?): Promise<KanbanCard> {
      // If no explicit position, append to end of target column.
      let newPos = position
      if (newPos === undefined) {
        const [card] = await db
          .select({ boardId: kanbanCards.boardId })
          .from(kanbanCards)
          .where(eq(kanbanCards.id, id))
          .limit(1)
        if (!card) throw new Error(`Kanban card not found: ${id}`)
        newPos = (await maxPos(card.boardId, columnId)) + POSITION_GAP
      }
      const [row] = await db
        .update(kanbanCards)
        .set({ columnId, position: newPos, updatedAt: new Date() })
        .where(eq(kanbanCards.id, id))
        .returning()
      if (!row) throw new Error(`Kanban card not found: ${id}`)
      return rowToCard(row)
    },

    async deleteCard(id): Promise<void> {
      await db.delete(kanbanCards).where(eq(kanbanCards.id, id))
    },

    async updateBoard(patch): Promise<KanbanBoard> {
      const boardId = await getOrCreateBoardId()
      // P1-4：删除列前校验该列内是否有卡片；删除标签前把悬空 labelId 从卡片上清掉。
      if (patch.columns !== undefined) {
        const cards = await db
          .select({ columnId: kanbanCards.columnId })
          .from(kanbanCards)
          .where(eq(kanbanCards.boardId, boardId))
        const newColumnIds = new Set(patch.columns.map((c) => c.id))
        const removedWithCards = new Map<string, number>()
        for (const card of cards) {
          if (!newColumnIds.has(card.columnId)) {
            removedWithCards.set(card.columnId, (removedWithCards.get(card.columnId) ?? 0) + 1)
          }
        }
        if (removedWithCards.size > 0) {
          const total = Array.from(removedWithCards.values()).reduce((a, b) => a + b, 0)
          throw new KanbanColumnInUseError(Array.from(removedWithCards.keys()), total)
        }
      }
      if (patch.labels !== undefined) {
        const labelIds = new Set(patch.labels.map((l) => l.id))
        const cards = await db
          .select({ id: kanbanCards.id, labels: kanbanCards.labels })
          .from(kanbanCards)
          .where(eq(kanbanCards.boardId, boardId))
        for (const card of cards) {
          const current = (card.labels ?? []) as string[]
          const kept = current.filter((lid) => labelIds.has(lid))
          if (kept.length !== current.length) {
            await db.update(kanbanCards).set({ labels: kept }).where(eq(kanbanCards.id, card.id))
          }
        }
      }
      const [boardRow] = await db
        .update(kanbanBoards)
        .set({
          ...(patch.columns !== undefined && { columns: patch.columns }),
          ...(patch.labels !== undefined && { labels: patch.labels }),
          updatedAt: new Date(),
        })
        .where(and(eq(kanbanBoards.projectId, projectId), isNull(kanbanBoards.deletedAt)))
        .returning()
      const row = boardRow as BoardRow
      return rowToBoard(row)
    },

    /** 整板替换（导入）：board 配置 + 卡片在单事务内重建；中途失败整体回滚，
     *  不残留「配置已换、卡片半新半旧」的混合状态。 */
    async replaceBoard(input): Promise<KanbanBoardWithCards> {
      const boardId = await getOrCreateBoardId()
      await db.transaction(async (tx) => {
        await tx.delete(kanbanCards).where(eq(kanbanCards.boardId, boardId))
        await tx
          .update(kanbanBoards)
          .set({ columns: input.columns, labels: input.labels, updatedAt: new Date() })
          .where(eq(kanbanBoards.id, boardId))
        if (input.cards.length > 0) {
          await tx.insert(kanbanCards).values(
            input.cards.map((c) => ({
              boardId,
              title: c.title,
              description: c.description ?? null,
              columnId: c.columnId,
              priority: c.priority,
              position: c.position,
              labels: c.labels,
            })),
          )
        }
      })
      const boardRow = await db
        .select()
        .from(kanbanBoards)
        .where(eq(kanbanBoards.id, boardId))
        .limit(1)
      const board = boardRow[0] as BoardRow
      const cards = await db
        .select()
        .from(kanbanCards)
        .where(eq(kanbanCards.boardId, boardId))
        .orderBy(asc(kanbanCards.columnId), asc(kanbanCards.position))
      return { ...rowToBoard(board), cards: cards.map(rowToCard) }
    },
  }
}

export { createKanbanStore, KanbanColumnInUseError }

// ── P2-5：看板回收站（软删除 → 恢复/彻底删除 → 到期物理清除）──────────────
// 与会话回收站同保留期（TRASH_RETENTION_MS）。项目删除时看板不再级联销毁。

/** 回收站条目信息（列表展示用）。 */
export type DeletedKanbanBoard = {
  id: string
  /** 删除时记录的原项目名（项目行已删除，无法再 join）。 */
  projectName: string
  cardCount: number
  deletedAt: number
}

/** 把活动看板软删除进回收站（记录原项目名）。项目行删除后 FK 将 projectId 置 null。 */
export async function softDeleteKanbanBoard(
  handle: DB,
  projectId: string,
  projectName: string | null,
): Promise<boolean> {
  const rows = await handle.db
    .update(kanbanBoards)
    .set({
      deletedAt: new Date(),
      deletedProjectName: projectName ?? undefined,
      updatedAt: new Date(),
    })
    .where(and(eq(kanbanBoards.projectId, projectId), isNull(kanbanBoards.deletedAt)))
    .returning({ id: kanbanBoards.id })
  return rows.length > 0
}

/** 回收站看板列表（含卡片数）。 */
export async function listDeletedKanbanBoards(handle: DB): Promise<DeletedKanbanBoard[]> {
  const boards = await handle.db
    .select()
    .from(kanbanBoards)
    .where(isNotNull(kanbanBoards.deletedAt))
    .orderBy(asc(kanbanBoards.deletedAt))
  if (boards.length === 0) return []
  const counts = await handle.db
    .select({ boardId: kanbanCards.boardId, n: sql<number>`count(*)::int` })
    .from(kanbanCards)
    .where(
      inArray(
        kanbanCards.boardId,
        boards.map((b) => b.id),
      ),
    )
    .groupBy(kanbanCards.boardId)
  const countMap = new Map(counts.map((c) => [c.boardId, c.n]))
  return boards.map((b) => {
    // isNotNull(deletedAt) 已过滤，此处必有值
    const deletedAt = b.deletedAt as Date
    return {
      id: b.id,
      projectName: b.deletedProjectName ?? '未知项目',
      cardCount: countMap.get(b.id) ?? 0,
      deletedAt: deletedAt instanceof Date ? deletedAt.getTime() : new Date(deletedAt).getTime(),
    }
  })
}

export type RestoreKanbanBoardResult =
  | { ok: true }
  | { ok: false; reason: 'BOARD_NOT_FOUND' | 'TARGET_HAS_BOARD' }

/** 恢复看板到指定项目：目标项目已有活动看板 → 409 语义（不覆盖用户现有看板）。 */
export async function restoreKanbanBoard(
  handle: DB,
  boardId: string,
  projectId: string,
): Promise<RestoreKanbanBoardResult> {
  const [active] = await handle.db
    .select({ id: kanbanBoards.id })
    .from(kanbanBoards)
    .where(and(eq(kanbanBoards.projectId, projectId), isNull(kanbanBoards.deletedAt)))
    .limit(1)
  if (active) return { ok: false, reason: 'TARGET_HAS_BOARD' }
  const rows = await handle.db
    .update(kanbanBoards)
    .set({ projectId, deletedAt: null, deletedProjectName: null, updatedAt: new Date() })
    .where(and(eq(kanbanBoards.id, boardId), isNotNull(kanbanBoards.deletedAt)))
    .returning({ id: kanbanBoards.id })
  return rows.length > 0 ? { ok: true } : { ok: false, reason: 'BOARD_NOT_FOUND' }
}

/** 回收站内彻底删除看板（不可恢复）。 */
export async function permanentlyDeleteKanbanBoard(handle: DB, boardId: string): Promise<number> {
  const rows = await handle.db
    .delete(kanbanBoards)
    .where(and(eq(kanbanBoards.id, boardId), isNotNull(kanbanBoards.deletedAt)))
    .returning({ id: kanbanBoards.id })
  return rows.length
}

/** 物理清除到期看板（软删除超过 retentionMs；与 purgeDeletedSessions 同调度）。 */
export async function purgeDeletedKanbanBoards(handle: DB, retentionMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionMs)
  const rows = await handle.db
    .delete(kanbanBoards)
    .where(and(isNotNull(kanbanBoards.deletedAt), lt(kanbanBoards.deletedAt, cutoff)))
    .returning({ id: kanbanBoards.id })
  return rows.length
}
