/**
 * Kanban shared types — used by backend store, kanban tool, REST routes,
 * and frontend components.
 */

/** A kanban column definition (stored as JSON in kanban_boards.columns). */
type KanbanColumnDef = {
  id: string
  name: string
}

/** A kanban label definition (stored as JSON in kanban_boards.labels). */
type KanbanLabelDef = {
  id: string
  name: string
  /** Hex color, e.g. "#ef4444" */
  color: string
}

/** Card priority level. */
type KanbanPriority = 'high' | 'medium' | 'low'

/** A kanban card (task). */
type KanbanCard = {
  id: string
  boardId: string
  title: string
  description: string | null
  columnId: string
  priority: KanbanPriority
  position: number
  /** Label ids referencing board.labels[].id */
  labels: string[]
  createdAt: string
  updatedAt: string
}

/** A kanban board (one per project). */
type KanbanBoard = {
  id: string
  projectId: string
  columns: KanbanColumnDef[]
  labels: KanbanLabelDef[]
  createdAt: string
  updatedAt: string
}

/** Board with all its cards (the full payload for GET /api/kanban/:projectId). */
type KanbanBoardWithCards = KanbanBoard & {
  cards: KanbanCard[]
}

/** Default 5 columns for a new board. */
const DEFAULT_KANBAN_COLUMNS: readonly KanbanColumnDef[] = [
  { id: 'todo', name: '待办' },
  { id: 'in_progress', name: '进行中' },
  { id: 'in_review', name: '审核中' },
  { id: 'done', name: '已完成' },
  { id: 'cancelled', name: '已取消' },
] as const

/** A curated palette for new labels (user can pick or override). */
const KANBAN_LABEL_COLORS: readonly string[] = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
] as const

/** Dependency-reversal interface for the `kanban` tool (host injects a db-backed
 *  implementation, mirroring the todoState pattern). */
interface KanbanStore {
  getBoard(): Promise<KanbanBoardWithCards>
  addCard(input: {
    title: string
    description?: string | null
    columnId?: string
    priority?: KanbanPriority
    labels?: string[]
  }): Promise<KanbanCard>
  updateCard(
    id: string,
    patch: {
      title?: string
      description?: string | null
      priority?: KanbanPriority
      labels?: string[]
    },
  ): Promise<KanbanCard>
  moveCard(id: string, columnId: string, position?: number): Promise<KanbanCard>
  deleteCard(id: string): Promise<void>
  updateBoard(patch: {
    columns?: KanbanColumnDef[]
    labels?: KanbanLabelDef[]
  }): Promise<KanbanBoard>
}

export type {
  KanbanBoard,
  KanbanBoardWithCards,
  KanbanCard,
  KanbanColumnDef,
  KanbanLabelDef,
  KanbanPriority,
  KanbanStore,
}

export { DEFAULT_KANBAN_COLUMNS, KANBAN_LABEL_COLORS }
