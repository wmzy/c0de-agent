import { eq, isNotNull } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { kanbanBoards, kanbanCards, projects } from '../db/schema.js'
import { DEFAULT_KANBAN_COLUMNS } from '../shared/types/kanban.js'
import {
  createKanbanStore,
  getDeletedKanbanBoard,
  KanbanColumnInUseError,
  KanbanColumnNotFoundError,
  KanbanInvalidPriorityError,
  listDeletedKanbanBoards,
  mergeKanbanBoard,
  permanentlyDeleteKanbanBoard,
  purgeDeletedKanbanBoards,
  restoreKanbanBoard,
  softDeleteKanbanBoard,
} from './store.js'

let handle: DB

beforeEach(async () => {
  handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
})
afterEach(async () => {
  await handle.close()
})

/** Seed a project row so the kanban_boards.project_id FK is satisfied. */
async function seedProject(id: string): Promise<void> {
  await handle.db.insert(projects).values({ id, worktree: `/repo/${id}` })
}

// A valid-format uuid that does not exist; hits the "not found" code path
// rather than triggering a Postgres uuid parse error.
const MISSING_ID = '00000000-0000-0000-0000-000000000000'

describe('createKanbanStore — initial board', () => {
  it('lazily creates a board with the default 5 columns, no labels, no cards', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const board = await store.getBoard()

    expect(board.projectId).toBe('proj-1')
    expect(board.columns).toEqual([...DEFAULT_KANBAN_COLUMNS])
    expect(board.labels).toEqual([])
    expect(board.cards).toEqual([])
    // timestamps are exposed as ISO 8601 strings (mapper contract).
    expect(Number.isFinite(Date.parse(board.createdAt))).toBe(true)
    expect(Number.isFinite(Date.parse(board.updatedAt))).toBe(true)
  })

  it('is idempotent: repeated getBoard returns the same board id', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const a = await store.getBoard()
    const b = await store.getBoard()
    expect(a.id).toBe(b.id)
    expect(b.cards).toHaveLength(0)
  })
})

describe('addCard', () => {
  it('applies defaults: todo column, medium priority, empty labels, null description', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const card = await store.addCard({ title: 'First task' })

    expect(card.title).toBe('First task')
    expect(card.columnId).toBe('todo')
    expect(card.priority).toBe('medium')
    expect(card.labels).toEqual([])
    expect(card.description).toBeNull()
    // First card in the column: maxPos(0) + POSITION_GAP(1000).
    expect(card.position).toBe(1000)
    expect(card.boardId).toBeTruthy()
    expect(Number.isFinite(Date.parse(card.createdAt))).toBe(true)
  })

  it('increments position by POSITION_GAP for successive cards in a column', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const c1 = await store.addCard({ title: 'a' })
    const c2 = await store.addCard({ title: 'b' })
    const c3 = await store.addCard({ title: 'c' })

    expect(c1.position).toBe(1000)
    expect(c2.position).toBe(2000)
    expect(c3.position).toBe(3000)
  })

  it('tracks position independently per column', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    await store.addCard({ title: 'todo-1', columnId: 'todo' })
    const inProg = await store.addCard({ title: 'inprog-1', columnId: 'in_progress' })

    // Fresh counter for the in_progress column.
    expect(inProg.position).toBe(1000)
  })

  it('respects explicit columnId, priority, labels, and description', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const card = await store.addCard({
      title: 'Detailed',
      description: 'do the thing',
      columnId: 'done',
      priority: 'high',
      labels: ['bug', 'urgent'],
    })

    expect(card.columnId).toBe('done')
    expect(card.priority).toBe('high')
    expect(card.description).toBe('do the thing')
    expect(card.labels).toEqual(['bug', 'urgent'])
  })

  it('creates the board lazily when no getBoard was called first', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const card = await store.addCard({ title: 'lazy board' })
    const board = await store.getBoard()

    expect(card.boardId).toBe(board.id)
    expect(board.cards).toHaveLength(1)
  })

  it('rejects a columnId not in the board config, listing available columns', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')

    await expect(store.addCard({ title: 'ghost', columnId: 'nonexistent' })).rejects.toThrow(
      KanbanColumnNotFoundError,
    )
    await expect(store.addCard({ title: 'ghost', columnId: 'nonexistent' })).rejects.toThrow(
      /可用列/,
    )
    // 失败不落库：看板仍为空，避免幽灵卡片不可见。
    const board = await store.getBoard()
    expect(board.cards).toHaveLength(0)
  })

  it('falls back to the first column when the todo column was removed', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    // 删除空 todo 列后，无参 addCard 不再硬编码落到悬空的 'todo'。
    await store.updateBoard({
      columns: DEFAULT_KANBAN_COLUMNS.filter((c) => c.id !== 'todo'),
    })

    const card = await store.addCard({ title: 'no column given' })

    expect(card.columnId).toBe('in_progress')
    const board = await store.getBoard()
    expect(board.columns.some((c) => c.id === card.columnId)).toBe(true)
  })

  it('rejects an invalid priority value', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')

    await expect(store.addCard({ title: 'bad', priority: 'urgent' as never })).rejects.toThrow(
      KanbanInvalidPriorityError,
    )
    const board = await store.getBoard()
    expect(board.cards).toHaveLength(0)
  })
})

describe('getBoard — card ordering', () => {
  it('returns cards sorted by columnId then position', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    // Insert out of order across columns.
    await store.addCard({ title: 'todo-2', columnId: 'todo' })
    await store.addCard({ title: 'done-1', columnId: 'done' })
    await store.addCard({ title: 'todo-1', columnId: 'todo' })
    await store.addCard({ title: 'inprog-1', columnId: 'in_progress' })

    const board = await store.getBoard()
    // Alphabetical column order: done < in_progress < todo; within a column
    // ascending position = insertion order (todo-2 added before todo-1).
    expect(board.cards.map((c) => c.title)).toEqual(['done-1', 'inprog-1', 'todo-2', 'todo-1'])
  })
})

describe('updateCard', () => {
  it('updates only the provided fields and preserves the rest', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const card = await store.addCard({
      title: 'orig',
      columnId: 'in_progress',
      priority: 'low',
      labels: ['x'],
    })

    const updated = await store.updateCard(card.id, {
      title: 'renamed',
      priority: 'high',
      labels: ['x', 'y'],
    })

    expect(updated.title).toBe('renamed')
    expect(updated.priority).toBe('high')
    expect(updated.labels).toEqual(['x', 'y'])
    // Untouched fields preserved.
    expect(updated.columnId).toBe('in_progress')
    expect(updated.position).toBe(card.position)
    expect(updated.description).toBeNull()
  })

  it('round-trips a null description', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const card = await store.addCard({ title: 't', description: 'has desc' })

    const updated = await store.updateCard(card.id, { description: null })
    expect(updated.description).toBeNull()
  })

  it('throws when the card does not exist', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')

    await expect(store.updateCard(MISSING_ID, { title: 'nope' })).rejects.toThrow(
      'Kanban card not found',
    )
  })
})

describe('moveCard', () => {
  it('moves to a new column and appends to the end when no position is given', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const card = await store.addCard({ title: 'mover', columnId: 'todo' })

    const moved = await store.moveCard(card.id, 'done')
    expect(moved.columnId).toBe('done')
    // 'done' was empty → maxPos(0) + 1000.
    expect(moved.position).toBe(1000)
  })

  it('appends after existing cards in the target column', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    await store.addCard({ title: 'existing', columnId: 'done' }) // done@1000
    const card = await store.addCard({ title: 'mover', columnId: 'todo' })

    const moved = await store.moveCard(card.id, 'done')
    expect(moved.columnId).toBe('done')
    expect(moved.position).toBe(2000)
  })

  it('uses the explicitly provided position verbatim', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const card = await store.addCard({ title: 'x', columnId: 'todo' })

    const moved = await store.moveCard(card.id, 'in_review', 42)
    expect(moved.columnId).toBe('in_review')
    expect(moved.position).toBe(42)
  })

  it('throws when the card does not exist', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')

    await expect(store.moveCard(MISSING_ID, 'done')).rejects.toThrow('Kanban card not found')
  })

  it('rejects moving to a column not in the board config', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const card = await store.addCard({ title: 'x', columnId: 'todo' })

    await expect(store.moveCard(card.id, 'ghost-column')).rejects.toThrow(KanbanColumnNotFoundError)
    // 卡片留在原列，未被静默移出可见范围。
    const board = await store.getBoard()
    expect(board.cards[0]?.columnId).toBe('todo')
  })
})

describe('deleteCard', () => {
  it('removes the card from the board', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const card = await store.addCard({ title: 'gone' })

    await store.deleteCard(card.id)

    const board = await store.getBoard()
    expect(board.cards).toHaveLength(0)
  })

  it('is a no-op for an unknown id (does not throw)', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')

    await expect(store.deleteCard(MISSING_ID)).resolves.toBeUndefined()
  })
})

describe('updateBoard', () => {
  it('replaces columns and labels', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const columns = [{ id: 'backlog', name: 'Backlog' }]
    const labels = [{ id: 'l1', name: 'P1', color: '#ef4444' }]

    const board = await store.updateBoard({ columns, labels })

    expect(board.columns).toEqual(columns)
    expect(board.labels).toEqual(labels)
  })

  it('updates only the provided field, preserving the other', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const labels = [{ id: 'l1', name: 'X', color: '#000000' }]
    await store.updateBoard({ labels })

    const board = await store.updateBoard({ columns: [{ id: 'c', name: 'C' }] })

    expect(board.columns).toEqual([{ id: 'c', name: 'C' }])
    expect(board.labels).toEqual(labels)
  })

  it('删除仍有卡片的列时抛 KanbanColumnInUseError（卡片不静默隐形）', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    await store.addCard({ title: 'todo-card', columnId: 'todo' })

    const columns = DEFAULT_KANBAN_COLUMNS.filter((c) => c.id !== 'todo')
    await expect(store.updateBoard({ columns: [...columns] })).rejects.toThrow(
      KanbanColumnInUseError,
    )
    // 卡片仍在
    const board = await store.getBoard()
    expect(board.cards).toHaveLength(1)
  })

  it('幽灵卡片（悬空列）冻结删列时，报错附卡片 id 指引删除', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    // 直接经 DB 写入悬空列卡片（历史脏数据/旧版本遗留），模拟死锁前状态。
    const board = await store.getBoard()
    const [ghost] = await handle.db
      .insert(kanbanCards)
      .values({
        boardId: board.id,
        title: 'invisible',
        columnId: 'gone-column',
        priority: 'medium',
        position: 1000,
        labels: [],
      })
      .returning()
    if (!ghost) throw new Error('ghost seed failed')

    // 删除任何现有列都会被幽灵卡片冻结——报错必须给出可执行的卡片 id。
    const kept = DEFAULT_KANBAN_COLUMNS.filter((c) => c.id !== 'done')
    await expect(store.updateBoard({ columns: [...kept] })).rejects.toThrow(
      new RegExp(ghost.id.slice(0, 8)),
    )
  })

  it('删除标签时把悬空 labelId 从卡片上清掉', async () => {
    await seedProject('proj-1')
    const store = createKanbanStore(handle, 'proj-1')
    const card = await store.addCard({ title: 't', labels: ['keep', 'gone'] })

    await store.updateBoard({
      labels: [{ id: 'keep', name: 'Keep', color: '#ef4444' }],
    })

    const board = await store.getBoard()
    expect(board.cards[0]?.labels).toEqual(['keep'])
    expect(card.id).toBe(board.cards[0]?.id)
  })
})

describe('project isolation', () => {
  it('keeps boards and cards separate per projectId', async () => {
    await seedProject('proj-a')
    await seedProject('proj-b')
    const storeA = createKanbanStore(handle, 'proj-a')
    const storeB = createKanbanStore(handle, 'proj-b')

    await storeA.addCard({ title: 'A-card' })
    await storeB.addCard({ title: 'B-card' })

    const [boardA, boardB] = await Promise.all([storeA.getBoard(), storeB.getBoard()])

    expect(boardA.id).not.toBe(boardB.id)
    expect(boardA.cards.map((c) => c.title)).toEqual(['A-card'])
    expect(boardB.cards.map((c) => c.title)).toEqual(['B-card'])
  })
})

describe('P2-5 kanban recycle bin', () => {
  it('soft delete → list → restore to target project', async () => {
    await seedProject('proj-a')
    await seedProject('proj-b')
    const storeA = createKanbanStore(handle, 'proj-a')
    await storeA.addCard({ title: 'keep-me' })

    // 项目删除时软删除看板（路由在删除项目行前调用；FK set null 由删除项目完成）
    expect(await softDeleteKanbanBoard(handle, 'proj-a', 'Old Project')).toBe(true)
    await handle.db.delete(projects).where(eq(projects.id, 'proj-a'))

    const deleted = await listDeletedKanbanBoards(handle)
    expect(deleted).toHaveLength(1)
    expect(deleted[0]?.projectName).toBe('Old Project')
    expect(deleted[0]?.cardCount).toBe(1)

    // 恢复到 proj-b
    const result = await restoreKanbanBoard(handle, deleted[0]?.id as string, 'proj-b')
    expect(result.ok).toBe(true)
    expect(await listDeletedKanbanBoards(handle)).toHaveLength(0)
    const storeB = createKanbanStore(handle, 'proj-b')
    const board = await storeB.getBoard()
    expect(board.cards.map((c) => c.title)).toEqual(['keep-me'])
  })

  it('restore to project with active board → TARGET_HAS_BOARD（不覆盖现有看板）', async () => {
    await seedProject('proj-a')
    await seedProject('proj-b')
    const storeA = createKanbanStore(handle, 'proj-a')
    const boardId = (await storeA.getBoard()).id
    const storeB = createKanbanStore(handle, 'proj-b')
    await storeB.addCard({ title: 'existing' })

    await softDeleteKanbanBoard(handle, 'proj-a', 'A')
    await handle.db.delete(projects).where(eq(projects.id, 'proj-a'))

    const result = await restoreKanbanBoard(handle, boardId, 'proj-b')
    expect(result).toEqual({ ok: false, reason: 'TARGET_HAS_BOARD' })
    // 现有看板未被覆盖
    const board = await storeB.getBoard()
    expect(board.cards.map((c) => c.title)).toEqual(['existing'])
  })

  it('merge into a project with active board → 列追加、卡片并入、源看板移除', async () => {
    await seedProject('proj-a')
    await seedProject('proj-b')
    const storeA = createKanbanStore(handle, 'proj-a')
    // 源看板自定义列 + 卡片（含 todo 列卡片与自定义列卡片）
    await storeA.updateBoard({
      columns: [
        { id: 'todo', name: '待办' },
        { id: 'custom', name: '自定义' },
      ],
    })
    await storeA.addCard({ title: 'src-todo', columnId: 'todo' })
    await storeA.addCard({ title: 'src-custom', columnId: 'custom' })
    await softDeleteKanbanBoard(handle, 'proj-a', 'A')
    await handle.db.delete(projects).where(eq(projects.id, 'proj-a'))

    const storeB = createKanbanStore(handle, 'proj-b')
    await storeB.addCard({ title: 'dst-todo', columnId: 'todo' })
    const deleted = await listDeletedKanbanBoards(handle)
    const boardId = deleted[0]?.id as string

    const result = await mergeKanbanBoard(handle, boardId, 'proj-b')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.mergedColumns).toBe(1)
    expect(result.mergedCards).toBe(2)

    const board = await storeB.getBoard()
    // 目标列保留 + 自定义列追加
    expect(board.columns.map((c) => c.id)).toContain('custom')
    expect(board.columns.map((c) => c.id)).toContain('todo')
    const titles = board.cards.map((c) => c.title).sort()
    expect(titles).toEqual(['dst-todo', 'src-custom', 'src-todo'])
    // 合并卡片 position 不重叠：同列 position 唯一
    const todoPositions = board.cards.filter((c) => c.columnId === 'todo').map((c) => c.position)
    expect(new Set(todoPositions).size).toBe(todoPositions.length)
    // 源看板已从回收站移除（物理删除）
    expect(await listDeletedKanbanBoards(handle)).toHaveLength(0)
  })

  it('merge into a project without board → 等价普通恢复', async () => {
    await seedProject('proj-a')
    await seedProject('proj-b')
    const storeA = createKanbanStore(handle, 'proj-a')
    await storeA.addCard({ title: 'only-card' })
    await softDeleteKanbanBoard(handle, 'proj-a', 'A')
    await handle.db.delete(projects).where(eq(projects.id, 'proj-a'))
    const boardId = (await listDeletedKanbanBoards(handle))[0]?.id as string

    const result = await mergeKanbanBoard(handle, boardId, 'proj-b')
    expect(result.ok).toBe(true)
    const board = await createKanbanStore(handle, 'proj-b').getBoard()
    expect(board.cards.map((c) => c.title)).toEqual(['only-card'])
    expect(await listDeletedKanbanBoards(handle)).toHaveLength(0)
  })

  it('merge 未知看板 → BOARD_NOT_FOUND', async () => {
    await seedProject('proj-b')
    const result = await mergeKanbanBoard(handle, MISSING_ID, 'proj-b')
    expect(result).toEqual({ ok: false, reason: 'BOARD_NOT_FOUND' })
  })

  it('permanent delete + purge retention', async () => {
    await seedProject('proj-a')
    const store = createKanbanStore(handle, 'proj-a')
    await store.addCard({ title: 'x' })
    const boardId = (await store.getBoard()).id
    await softDeleteKanbanBoard(handle, 'proj-a', 'A')
    await handle.db.delete(projects).where(eq(projects.id, 'proj-a'))

    // 彻底删除
    expect(await permanentlyDeleteKanbanBoard(handle, boardId)).toBe(1)
    expect(await permanentlyDeleteKanbanBoard(handle, boardId)).toBe(0)
    expect(await listDeletedKanbanBoards(handle)).toHaveLength(0)

    // 到期清除：把 deletedAt 拨回过去 → 第一次 purge 仅标记进入宽限期（不物理清除）
    await seedProject('proj-b')
    const storeB = createKanbanStore(handle, 'proj-b')
    await storeB.addCard({ title: 'y' })
    await softDeleteKanbanBoard(handle, 'proj-b', 'B')
    await handle.db.delete(projects).where(eq(projects.id, 'proj-b'))
    const past = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000)
    await handle.db
      .update(kanbanBoards)
      .set({ deletedAt: past })
      .where(isNotNull(kanbanBoards.deletedAt))
    const RETENTION = 60 * 24 * 60 * 60 * 1000
    const GRACE = 7 * 24 * 60 * 60 * 1000

    // 阶段一：到期 → 标记进入宽限期，仍在回收站可恢复
    expect(await purgeDeletedKanbanBoards(handle, RETENTION, GRACE)).toEqual({
      marked: 1,
      deleted: 0,
    })
    const marked = await listDeletedKanbanBoards(handle)
    expect(marked).toHaveLength(1)
    expect(marked[0]?.purgePendingAt).toBeGreaterThan(0)
    // 宽限期内重复调用不重复标记、不清除
    expect(await purgeDeletedKanbanBoards(handle, RETENTION, GRACE)).toEqual({
      marked: 0,
      deleted: 0,
    })

    // 阶段二：把 purgePendingAt 拨回超过宽限期 → 物理清除
    await handle.db
      .update(kanbanBoards)
      .set({ purgePendingAt: new Date(Date.now() - (GRACE + 24 * 60 * 60 * 1000)) })
      .where(isNotNull(kanbanBoards.deletedAt))
    expect(await purgeDeletedKanbanBoards(handle, RETENTION, GRACE)).toEqual({
      marked: 0,
      deleted: 1,
    })
    expect(await listDeletedKanbanBoards(handle)).toHaveLength(0)
  })

  it('soft delete 记录原工作目录，getDeletedKanbanBoard 可读取（供重建原项目）', async () => {
    await seedProject('proj-a')
    const store = createKanbanStore(handle, 'proj-a')
    await store.addCard({ title: 'w' })
    const boardId = (await store.getBoard()).id

    expect(await softDeleteKanbanBoard(handle, 'proj-a', 'A', '/repo/proj-a')).toBe(true)

    const board = await getDeletedKanbanBoard(handle, boardId)
    expect(board?.deletedProjectWorktree).toBe('/repo/proj-a')
    expect(board?.cardCount).toBe(1)
    // 未记录 worktree（旧调用路径/直接改行）时返回 null
    await handle.db
      .update(kanbanBoards)
      .set({ deletedProjectWorktree: null })
      .where(eq(kanbanBoards.id, boardId))
    expect((await getDeletedKanbanBoard(handle, boardId))?.deletedProjectWorktree).toBeNull()
  })

  it('删除看板后新项目同 id 重建项目 → 新看板不被旧回收站看板遮蔽', async () => {
    await seedProject('proj-a')
    const store = createKanbanStore(handle, 'proj-a')
    await store.addCard({ title: 'old' })
    await softDeleteKanbanBoard(handle, 'proj-a', 'A')
    await handle.db.delete(projects).where(eq(projects.id, 'proj-a'))

    // 同 id 项目重建（同目录重新注册）：新看板应全新创建，不含旧卡片
    await seedProject('proj-a')
    const fresh = createKanbanStore(handle, 'proj-a')
    const board = await fresh.getBoard()
    expect(board.cards).toHaveLength(0)
    // 旧看板仍在回收站（可恢复）
    expect(await listDeletedKanbanBoards(handle)).toHaveLength(1)
  })
})
