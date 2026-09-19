import { and, asc, eq, inArray, isNotNull, isNull, max, sql } from 'drizzle-orm'
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

/** 合法优先级枚举（运行时校验用——REST/tool 层输入未经 TS 约束）。 */
const VALID_PRIORITIES = new Set<KanbanPriority>(['high', 'medium', 'low'])

/** 列内仍有卡片时禁止删除该列（否则卡片静默不可见）。 */
class KanbanColumnInUseError extends Error {
  constructor(columnNames: string[], cardCount: number, cardIds: string[] = []) {
    const idHint =
      cardIds.length > 0
        ? `（示例卡片 id：${cardIds.slice(0, 5).join('、')}${cardIds.length > 5 ? ' 等' : ''}，可直接按 id 删除这些卡片）`
        : ''
    super(
      `列 [${columnNames.join(', ')}] 中仍有 ${cardCount} 张卡片，无法删除。` +
        `请先移动或删除这些卡片。${idHint}`,
    )
  }
}

/**
 * 目标列不存在（add/move 引用未配置的列）——与 import/删列的悬空列防护同口径：
 * 此前运行时 add/move 不校验，LLM 幻觉列名写入后卡片静默不可见，且幽灵卡片
 * 会反过来冻结列配置删除（KanbanColumnInUseError 死锁）。
 * 错误信息回传可用列清单，供 LLM 自纠而非再猜。
 */
class KanbanColumnNotFoundError extends Error {
  constructor(
    public readonly columnId: string,
    availableColumns: string[],
    op: 'add' | 'move',
  ) {
    const avail = availableColumns.length > 0 ? availableColumns.join('、') : '（看板无列）'
    super(
      `列 "${columnId}" 不存在，无法${op === 'add' ? '创建' : '移动'}卡片。` +
        `可用列：${avail}。请改用其中一个列 id。`,
    )
  }
}

/** 非法优先级（REST PATCH / kanbanTool 透传未校验值）。 */
class KanbanInvalidPriorityError extends Error {
  constructor(public readonly value: string) {
    super(`无效优先级 "${value}"，允许值：high、medium、low`)
  }
}

/** 卡片不存在（update/move 目标 id 无效）。 */
class KanbanCardNotFoundError extends Error {
  constructor(public readonly cardId: string) {
    super(`Kanban card not found: ${cardId}`)
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
    // 正常路径行一定存在（insert + onConflictDoNothing 已保证）。防御性兜底：
    // 唯一 projectId 槽位被软删行占用等异常态下不再返回 undefined id
    //（后续查询会静默查空、上层误判「板不存在」），显式抛错暴露问题。
    if (!row) {
      throw new Error(
        `Kanban board for project ${projectId} missing after ensure-insert (unique slot likely held by a soft-deleted row)`,
      )
    }
    return row.id
  }

  /** Max position in a column (0 if empty). */
  async function maxPos(boardId: string, columnId: string): Promise<number> {
    const [row] = await db
      .select({ m: max(kanbanCards.position) })
      .from(kanbanCards)
      .where(and(eq(kanbanCards.boardId, boardId), eq(kanbanCards.columnId, columnId)))
    return row?.m ?? 0
  }

  /** 当前板的列配置（add/move 的悬空列校验用）。 */
  async function boardColumns(boardId: string): Promise<KanbanColumnDef[]> {
    const [row] = await db
      .select({ columns: kanbanBoards.columns })
      .from(kanbanBoards)
      .where(eq(kanbanBoards.id, boardId))
      .limit(1)
    return (row?.columns ?? []) as KanbanColumnDef[]
  }

  /** 校验列存在；不存在抛 KanbanColumnNotFoundError（消息含可用列清单）。 */
  function assertColumn(columns: KanbanColumnDef[], columnId: string, op: 'add' | 'move'): void {
    if (!columns.some((c) => c.id === columnId)) {
      throw new KanbanColumnNotFoundError(
        columnId,
        columns.map((c) => c.id),
        op,
      )
    }
  }

  /** 校验优先级合法；非法抛 KanbanInvalidPriorityError。 */
  function assertPriority(priority: unknown): void {
    if (priority !== undefined && !VALID_PRIORITIES.has(priority as KanbanPriority)) {
      throw new KanbanInvalidPriorityError(String(priority))
    }
  }

  return {
    /** 只读获取板（不创建）：导出等纯读路径用——此前导出经 getBoard 懒建板，
     *  「导出」一个从未打开过看板的项目会凭空产生空板行。无板返回 null。 */
    async peekBoard(): Promise<KanbanBoardWithCards | null> {
      const [boardRow] = await db
        .select()
        .from(kanbanBoards)
        .where(and(eq(kanbanBoards.projectId, projectId), isNull(kanbanBoards.deletedAt)))
        .limit(1)
      if (!boardRow) return null
      const cards = await db
        .select()
        .from(kanbanCards)
        .where(eq(kanbanCards.boardId, boardRow.id))
        .orderBy(asc(kanbanCards.columnId), asc(kanbanCards.position))
      return { ...rowToBoard(boardRow), cards: cards.map(rowToCard) }
    },

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
      const columns = await boardColumns(boardId)
      // 默认列 = 板上第一列（而非硬编码 'todo'）：todo 列被删除/重排后
      // 硬编码默认会让无参 addCard 静默落入不存在的列（卡片不可见）。
      const columnId = input.columnId ?? columns[0]?.id ?? DEFAULT_COLUMN_ID
      assertColumn(columns, columnId, 'add')
      assertPriority(input.priority)
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
      assertPriority(patch.priority)
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
      if (!row) throw new KanbanCardNotFoundError(id)
      return rowToCard(row)
    },

    async moveCard(id, columnId, position?): Promise<KanbanCard> {
      const [card] = await db
        .select({ boardId: kanbanCards.boardId })
        .from(kanbanCards)
        .where(eq(kanbanCards.id, id))
        .limit(1)
      if (!card) throw new KanbanCardNotFoundError(id)
      // 悬空列校验：目标列必须存在于当前列配置，否则卡片静默不可见。
      const columns = await boardColumns(card.boardId)
      assertColumn(columns, columnId, 'move')
      // If no explicit position, append to end of target column.
      const newPos = position ?? (await maxPos(card.boardId, columnId)) + POSITION_GAP
      const [row] = await db
        .update(kanbanCards)
        .set({ columnId, position: newPos, updatedAt: new Date() })
        .where(eq(kanbanCards.id, id))
        .returning()
      const moved = row as CardRow
      return rowToCard(moved)
    },

    async deleteCard(id): Promise<void> {
      await db.delete(kanbanCards).where(eq(kanbanCards.id, id))
    },

    async updateBoard(patch): Promise<KanbanBoard> {
      const boardId = await getOrCreateBoardId()
      // P1-4：删除列前校验该列内是否有卡片；删除标签前把悬空 labelId 从卡片上清掉。
      if (patch.columns !== undefined) {
        const cards = await db
          .select({ id: kanbanCards.id, columnId: kanbanCards.columnId })
          .from(kanbanCards)
          .where(eq(kanbanCards.boardId, boardId))
        const newColumnIds = new Set(patch.columns.map((c) => c.id))
        const removedWithCards = new Map<string, number>()
        const orphanCardIds: string[] = []
        for (const card of cards) {
          if (!newColumnIds.has(card.columnId)) {
            removedWithCards.set(card.columnId, (removedWithCards.get(card.columnId) ?? 0) + 1)
            orphanCardIds.push(card.id)
          }
        }
        if (removedWithCards.size > 0) {
          const total = Array.from(removedWithCards.values()).reduce((a, b) => a + b, 0)
          throw new KanbanColumnInUseError(
            Array.from(removedWithCards.keys()),
            total,
            orphanCardIds,
          )
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

export {
  createKanbanStore,
  KanbanCardNotFoundError,
  KanbanColumnInUseError,
  KanbanColumnNotFoundError,
  KanbanInvalidPriorityError,
}

// ── P2-5：看板回收站（软删除 → 恢复/彻底删除 → 到期物理清除）──────────────
// 与会话回收站同保留期（TRASH_RETENTION_MS）。项目删除时看板不再级联销毁。

/** 回收站条目信息（列表展示用）。 */
export type DeletedKanbanBoard = {
  id: string
  /** 删除时记录的原项目名（项目行已删除，无法再 join）。 */
  projectName: string
  cardCount: number
  deletedAt: number
  /** 已到期进入物理清除宽限期的时间戳（ms）；null=尚未到期。 */
  purgePendingAt: number | null
  /** 删除时记录的原项目工作目录；null 或目录已不存在时无法「重建原项目」恢复。 */
  deletedProjectWorktree: string | null
}

/** 把活动看板软删除进回收站（记录原项目名与工作目录）。项目行删除后 FK 将 projectId 置 null。 */
export async function softDeleteKanbanBoard(
  handle: DB,
  projectId: string,
  projectName: string | null,
  worktree?: string | null,
): Promise<boolean> {
  const rows = await handle.db
    .update(kanbanBoards)
    .set({
      deletedAt: new Date(),
      deletedProjectName: projectName ?? undefined,
      deletedProjectWorktree: worktree ?? undefined,
      // 恢复后重删的看板须重新经历「到期 → 宽限」周期，宽限标记不跨删除周期生效。
      purgePendingAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(kanbanBoards.projectId, projectId), isNull(kanbanBoards.deletedAt)))
    .returning({ id: kanbanBoards.id })
  return rows.length > 0
}

/** 行 + 卡片数 → 回收站条目（时间戳统一转 ms，兼容 Date/null/字符串）。 */
function toDeletedBoard(b: BoardRow, cardCount: number): DeletedKanbanBoard {
  const toMs = (d: Date | string | number | null | undefined): number | null => {
    if (d == null) return null
    const t = d instanceof Date ? d.getTime() : new Date(d).getTime()
    return Number.isFinite(t) ? t : null
  }
  return {
    id: b.id,
    projectName: b.deletedProjectName ?? '未知项目',
    cardCount,
    deletedAt: toMs(b.deletedAt) ?? 0,
    purgePendingAt: toMs(b.purgePendingAt),
    deletedProjectWorktree: b.deletedProjectWorktree ?? null,
  }
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
  return boards.map((b) => toDeletedBoard(b, countMap.get(b.id) ?? 0))
}

/** 按 id 取单个回收站看板（供「重建原项目」恢复读取原工作目录）。 */
export async function getDeletedKanbanBoard(
  handle: DB,
  boardId: string,
): Promise<DeletedKanbanBoard | null> {
  const [b] = await handle.db
    .select()
    .from(kanbanBoards)
    .where(and(eq(kanbanBoards.id, boardId), isNotNull(kanbanBoards.deletedAt)))
    .limit(1)
  if (!b) return null
  const counts = await handle.db
    .select({ n: sql<number>`count(*)::int` })
    .from(kanbanCards)
    .where(eq(kanbanCards.boardId, boardId))
  return toDeletedBoard(b, counts[0]?.n ?? 0)
}

export type RestoreKanbanBoardResult =
  | { ok: true }
  | { ok: false; reason: 'BOARD_NOT_FOUND' | 'TARGET_HAS_BOARD' }

/** 恢复看板到指定项目：目标项目已有活动看板 → 409 语义（不覆盖用户现有看板）。
 *  P2 修复：检查与更新放进单事务，并发下撞 uq_kanban_boards_project 唯一索引时
 *  降级为 TARGET_HAS_BOARD（此前抛 PG 错误 500）。 */
export async function restoreKanbanBoard(
  handle: DB,
  boardId: string,
  projectId: string,
): Promise<RestoreKanbanBoardResult> {
  try {
    return await handle.db.transaction(async (tx) => {
      const [active] = await tx
        .select({ id: kanbanBoards.id })
        .from(kanbanBoards)
        .where(and(eq(kanbanBoards.projectId, projectId), isNull(kanbanBoards.deletedAt)))
        .limit(1)
      if (active) return { ok: false, reason: 'TARGET_HAS_BOARD' } as const
      const rows = await tx
        .update(kanbanBoards)
        .set({
          projectId,
          deletedAt: null,
          deletedProjectName: null,
          deletedProjectWorktree: null,
          purgePendingAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(kanbanBoards.id, boardId), isNotNull(kanbanBoards.deletedAt)))
        .returning({ id: kanbanBoards.id })
      if (rows.length === 0) return { ok: false, reason: 'BOARD_NOT_FOUND' } as const
      return { ok: true } as const
    })
  } catch (err) {
    // PG 23505 = unique_violation：并发窗口内目标板被创建。
    if ((err as { code?: string }).code === '23505') {
      return { ok: false, reason: 'TARGET_HAS_BOARD' }
    }
    throw err
  }
}

export type MergeKanbanBoardResult =
  | { ok: true; mergedColumns: number; mergedCards: number }
  | { ok: false; reason: 'BOARD_NOT_FOUND' }

/**
 * P1 修复：把回收站看板合并进目标项目的活动看板（TARGET_HAS_BOARD 死胡同的出口）。
 * 此前「目标项目已有看板」时恢复 409，而产品没有删除活动看板的能力，用户无法
 * 把旧项目卡片拿回现有项目——现在 merge 模式下：
 *  - 目标无活动看板 → 等价普通恢复（重新归属）；
 *  - 目标有活动看板 → 追加缺失列，卡片并入对应列末尾（position 重新计算避免
 *    与目标卡片重叠）；源卡片引用源板已不存在列时落到目标第一列（保证可见）；
 *  - 合并成功后源看板物理删除（卡片已迁移，FK cascade 清源卡）。
 * 全程单事务：失败整体回滚，不残留半合并状态。
 */
export async function mergeKanbanBoard(
  handle: DB,
  boardId: string,
  projectId: string,
): Promise<MergeKanbanBoardResult> {
  return await handle.db.transaction(async (tx) => {
    const [src] = await tx
      .select({ id: kanbanBoards.id, columns: kanbanBoards.columns })
      .from(kanbanBoards)
      .where(and(eq(kanbanBoards.id, boardId), isNotNull(kanbanBoards.deletedAt)))
      .limit(1)
    if (!src) return { ok: false, reason: 'BOARD_NOT_FOUND' } as const

    const [target] = await tx
      .select({ id: kanbanBoards.id, columns: kanbanBoards.columns })
      .from(kanbanBoards)
      .where(and(eq(kanbanBoards.projectId, projectId), isNull(kanbanBoards.deletedAt)))
      .limit(1)

    // 目标无活动看板 → 重新归属（等价普通恢复，但保持 merge 调用幂等语义）。
    if (!target) {
      const rows = await tx
        .update(kanbanBoards)
        .set({
          projectId,
          deletedAt: null,
          deletedProjectName: null,
          deletedProjectWorktree: null,
          purgePendingAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(kanbanBoards.id, boardId), isNotNull(kanbanBoards.deletedAt)))
        .returning({ id: kanbanBoards.id })
      if (rows.length === 0) return { ok: false, reason: 'BOARD_NOT_FOUND' } as const
      return { ok: true, mergedColumns: 0, mergedCards: 0 } as const
    }

    // —— 合并路径 ——
    const srcCols = (src.columns ?? []) as KanbanColumnDef[]
    const targetCols = (target.columns ?? []) as KanbanColumnDef[]
    const targetIds = new Set(targetCols.map((c) => c.id))
    const newCols = srcCols.filter((c) => !targetIds.has(c.id))
    if (newCols.length > 0) {
      await tx
        .update(kanbanBoards)
        .set({ columns: [...targetCols, ...newCols], updatedAt: new Date() })
        .where(eq(kanbanBoards.id, target.id))
    }

    const mergedCols = [...targetCols, ...newCols]
    const fallbackCol = mergedCols[0]?.id ?? DEFAULT_COLUMN_ID
    const srcCards = await tx
      .select()
      .from(kanbanCards)
      .where(eq(kanbanCards.boardId, boardId))
      .orderBy(asc(kanbanCards.position))

    // 目标各列现有 max(position)：合并卡片追加到末尾，避免 position 重叠。
    const targetMax = await tx
      .select({ columnId: kanbanCards.columnId, m: max(kanbanCards.position) })
      .from(kanbanCards)
      .where(eq(kanbanCards.boardId, target.id))
      .groupBy(kanbanCards.columnId)
    const maxMap = new Map(targetMax.map((r) => [r.columnId, r.m ?? 0]))
    const counters = new Map<string, number>()
    let mergedCards = 0
    for (const card of srcCards) {
      const colId = mergedCols.some((c) => c.id === card.columnId) ? card.columnId : fallbackCol
      const idx = counters.get(colId) ?? 0
      counters.set(colId, idx + 1)
      await tx.insert(kanbanCards).values({
        boardId: target.id,
        title: card.title,
        description: card.description,
        columnId: colId,
        priority: card.priority,
        position: (maxMap.get(colId) ?? 0) + POSITION_GAP * (idx + 1),
        labels: card.labels ?? [],
      })
      mergedCards += 1
    }

    // 源看板物理删除（卡片已迁移；卡片行经 FK cascade 连带清除）。
    await tx.delete(kanbanBoards).where(eq(kanbanBoards.id, boardId))
    return { ok: true, mergedColumns: newCols.length, mergedCards } as const
  })
}

/** 回收站内彻底删除看板（不可恢复）。 */
export async function permanentlyDeleteKanbanBoard(handle: DB, boardId: string): Promise<number> {
  const rows = await handle.db
    .delete(kanbanBoards)
    .where(and(eq(kanbanBoards.id, boardId), isNotNull(kanbanBoards.deletedAt)))
    .returning({ id: kanbanBoards.id })
  return rows.length
}

/** 两阶段清理结果：marked = 本次新标记进入宽限期的条目数；deleted = 本次物理清除数。 */
export type KanbanTrashPurgeResult = { marked: number; deleted: number }

/**
 * 看板回收站两阶段清理（与会话 purgeDeletedSessions 同策略，杜绝「到期即静默清空」）：
 *  - 阶段一：软删除超过 retentionMs 且尚未标记 → 写 purgePendingAt（进入宽限期，
 *    UI 显示「即将清除」仍可恢复）；
 *  - 阶段二：purgePendingAt 早于 graceMs 截止 → 物理清除（卡片经 FK cascade 连带删除）。
 * 看板回收站全局单一分组、无「首次查看才起算」语义，保留期自删除时刻起算，稳定可预期。
 */
export async function purgeDeletedKanbanBoards(
  handle: DB,
  retentionMs: number,
  graceMs: number,
): Promise<KanbanTrashPurgeResult> {
  const retentionCutoff = new Date(Date.now() - retentionMs)
  const graceCutoff = new Date(Date.now() - graceMs)
  const rows = await handle.db
    .select({
      id: kanbanBoards.id,
      deletedAt: kanbanBoards.deletedAt,
      purgePendingAt: kanbanBoards.purgePendingAt,
    })
    .from(kanbanBoards)
    .where(isNotNull(kanbanBoards.deletedAt))

  // —— 阶段一：到期标记（先宽限，不直接清除）——
  let marked = 0
  for (const r of rows) {
    if (!r.deletedAt) continue
    if (r.purgePendingAt) continue
    if (r.deletedAt.getTime() >= retentionCutoff.getTime()) continue
    await handle.db
      .update(kanbanBoards)
      .set({ purgePendingAt: new Date(), updatedAt: new Date() })
      .where(eq(kanbanBoards.id, r.id))
    marked += 1
  }

  // —— 阶段二：宽限期满物理清除 ——
  const pendingIds = rows
    .filter((r) => r.purgePendingAt && r.purgePendingAt.getTime() < graceCutoff.getTime())
    .map((r) => r.id)
  let deleted = 0
  if (pendingIds.length > 0) {
    const removed = await handle.db
      .delete(kanbanBoards)
      .where(inArray(kanbanBoards.id, pendingIds))
      .returning({ id: kanbanBoards.id })
    deleted = removed.length
  }
  return { marked, deleted }
}
