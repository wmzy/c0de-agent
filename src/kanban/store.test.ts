import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { projects } from '../db/schema.js'
import { DEFAULT_KANBAN_COLUMNS } from '../shared/types/kanban.js'
import { createKanbanStore } from './store.js'

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
