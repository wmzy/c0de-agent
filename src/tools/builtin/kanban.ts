// kanban tool: project-scoped task board for agent collaboration.
// Mirrors the todo tool's ToolDef pattern but persists to DB (per-project)
// instead of in-memory session state. Agents can add, move, update, delete
// tasks and view the full board — enabling human↔agent and agent↔agent
// coordination via a shared kanban board.

import type { JSONSchema } from '../../shared/types/base.js'
import type { KanbanPriority } from '../../shared/types/kanban.js'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'

// =============================================================================
// Types
// =============================================================================

type KanbanInput =
  | { op: 'view' }
  | {
      op: 'add'
      title: string
      description?: string
      columnId?: string
      priority?: KanbanPriority
      labels?: string[]
    }
  | {
      op: 'update'
      id: string
      title?: string
      description?: string | null
      priority?: KanbanPriority
      labels?: string[]
    }
  | { op: 'move'; id: string; columnId: string; position?: number }
  | { op: 'delete'; id: string }

// =============================================================================
// Summary formatter
// =============================================================================

/** Priority display symbol for compact board summary. */
const PRIORITY_SYMBOL: Record<KanbanPriority, string> = {
  high: '🔴',
  medium: '🟡',
  low: '⚪',
}

function formatBoardSummary(
  board: {
    columns: { id: string; name: string }[]
    cards: {
      id: string
      title: string
      columnId: string
      priority: KanbanPriority
      description: string | null
    }[]
  },
  errors: string[] = [],
): string {
  const lines: string[] = []
  if (errors.length > 0) lines.push(`Errors: ${errors.join('; ')}`)

  for (const col of board.columns) {
    const cards = board.cards.filter((c) => c.columnId === col.id)
    lines.push(`## ${col.name} (${cards.length})`)
    for (const card of cards) {
      const shortId = card.id.slice(0, 8)
      const sym = PRIORITY_SYMBOL[card.priority] ?? ''
      lines.push(`  ${sym} [${shortId}] ${card.title}`)
      if (card.description) {
        const preview =
          card.description.length > 80 ? `${card.description.slice(0, 77)}…` : card.description
        lines.push(`      ${preview}`)
      }
    }
    if (cards.length === 0) lines.push('  (empty)')
  }

  const total = board.cards.length
  lines.push(`\nTotal: ${total} card(s).`)
  if (total === 0) lines.push('Board is empty — use kanban add to create tasks.')

  return lines.join('\n')
}

// =============================================================================
// Schema
// =============================================================================

const kanbanParameters: JSONSchema = {
  type: 'object',
  description: 'Apply a single kanban board operation',
  properties: {
    op: {
      type: 'string',
      enum: ['view', 'add', 'update', 'move', 'delete'],
      description: 'Operation to apply',
    },
    title: { type: 'string', description: 'Task title (for add, update)' },
    description: { type: 'string', description: 'Task description (for add, update)' },
    id: { type: 'string', description: 'Card id (for update, move, delete)' },
    columnId: {
      type: 'string',
      description: 'Column id to place/move the card (for add, move)',
    },
    priority: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'Priority level (for add, update)',
    },
    labels: {
      type: 'array',
      items: { type: 'string' },
      description: 'Label ids (for add, update)',
    },
    position: {
      type: 'number',
      description: 'Position within column (for move). Omit to append.',
    },
  },
  required: ['op'],
  additionalProperties: false,
}

// =============================================================================
// Tool definition
// =============================================================================

/** kanban tool: project-scoped task board for human↔agent collaboration.
 *  Permission: auto (operates on the project's kanban board, no system side effects).
 *  State persists in DB via ctx.kanbanStore (dependency-reversal, like todoState). */
export const kanbanTool: ToolDef = {
  name: 'kanban',
  description: `Manage the project's shared kanban task board. 5 operations:
- view: list all columns and cards (read-only)
- add: create a new task card (title required; optional description, columnId defaults to todo, priority defaults to medium, labels)
- update: edit a card's title/description/priority/labels (id required)
- move: move a card to a different column or reorder (id + columnId required; optional position)
- delete: remove a card (id required)

The board is shared across all sessions and agents in the same project — use it to coordinate work, track tasks visible to the user, and break down complex projects. Column ids are: todo, in_progress, in_review, done, cancelled (customizable by the user via the board config UI).`,
  parameters: kanbanParameters,
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const params = input as KanbanInput
    const store = ctx.kanbanStore
    if (!store) {
      return { _tag: 'error', error: 'Kanban store not available in this context' }
    }

    const errors: string[] = []

    try {
      switch (params.op) {
        case 'view': {
          const board = await store.getBoard()
          return {
            _tag: 'success',
            output: formatBoardSummary(board),
            metadata: { board },
          }
        }

        case 'add': {
          const addTitle = params.title?.trim()
          if (!addTitle) {
            errors.push('title is required for add')
          }
          if (errors.length > 0) break
          const card = await store.addCard({
            title: addTitle,
            description: params.description ?? null,
            columnId: params.columnId,
            priority: params.priority,
            labels: params.labels,
          })
          const board = await store.getBoard()
          return {
            _tag: 'success',
            output: `Card added: [${card.id.slice(0, 8)}] "${card.title}"\n\n${formatBoardSummary(board)}`,
            metadata: { card, board },
          }
        }

        case 'update': {
          const updateId = params.id?.trim()
          if (!updateId) {
            errors.push('id is required for update')
          }
          if (errors.length > 0) break
          const card = await store.updateCard(updateId, {
            ...(params.title !== undefined && { title: params.title }),
            ...(params.description !== undefined && { description: params.description }),
            ...(params.priority !== undefined && { priority: params.priority }),
            ...(params.labels !== undefined && { labels: params.labels }),
          })
          const board = await store.getBoard()
          return {
            _tag: 'success',
            output: `Card updated: [${card.id.slice(0, 8)}] "${card.title}"\n\n${formatBoardSummary(board)}`,
            metadata: { card, board },
          }
        }

        case 'move': {
          const moveId = params.id?.trim()
          const targetCol = params.columnId?.trim()
          if (!moveId) {
            errors.push('id is required for move')
          }
          if (!targetCol) {
            errors.push('columnId is required for move')
          }
          if (errors.length > 0) break
          const card = await store.moveCard(moveId, targetCol, params.position)
          const board = await store.getBoard()
          return {
            _tag: 'success',
            output: `Card moved: [${card.id.slice(0, 8)}] "${card.title}" → ${targetCol}\n\n${formatBoardSummary(board)}`,
            metadata: { card, board },
          }
        }

        case 'delete': {
          const deleteId = params.id?.trim()
          if (!deleteId) {
            errors.push('id is required for delete')
          }
          if (errors.length > 0) break
          await store.deleteCard(deleteId)
          const board = await store.getBoard()
          return {
            _tag: 'success',
            output: `Card deleted: ${deleteId.slice(0, 8)}\n\n${formatBoardSummary(board)}`,
            metadata: { board },
          }
        }

        default:
          errors.push(`Unknown op: ${(params as { op: string }).op}`)
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }

    // Errors are surfaced in output text (like todo tool) so the LLM can read
    // and retry. Return success to avoid skewing tool metrics.
    const board = await store.getBoard()
    return {
      _tag: 'success',
      output: formatBoardSummary(board, errors),
      metadata: { board },
    }
  },
}

export type { KanbanInput }
