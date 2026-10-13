import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { ToolError, ToolInlineError } from '@/components/session/tools/toolError.js'
import { ToolTruncated } from '@/components/session/tools/toolTruncated.js'

type KanbanCard = {
  id: string
  title: string
  columnId: string
  priority: 'high' | 'medium' | 'low'
  description: string | null
}

type KanbanColumn = { id: string; name: string }

type KanbanBoard = {
  columns: KanbanColumn[]
  cards: KanbanCard[]
}

type KanbanInput = {
  op?: string
  title?: string
  id?: string
  columnId?: string
  priority?: string
}

const PRIORITY_DOT: Record<string, string> = {
  high: '🔴',
  medium: '🟡',
  low: '⚪',
}

const opLabel = css`
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  color: var(--haze-color-primary);
  background: color-mix(in srgb, var(--haze-color-primary) 10%, transparent);
  padding: 1px 6px;
  border-radius: 3px;
  margin-bottom: 6px;
`

const boardStyle = css`
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const colHeader = css`
  font-size: 11px;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-top: 4px;
`

const cardRow = css`
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding: 1px 0;
  font-size: 12px;
  line-height: 1.4;
`

const empty = css`
  color: var(--haze-color-text-secondary);
  font-size: 13px;
  font-style: italic;
`

const detail = css`
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  margin-bottom: 4px;
`

/** Render the kanban board (columns with cards). */
function BoardView({ board }: { board: KanbanBoard }) {
  if (board.cards.length === 0) {
    return <div className={empty}>看板为空</div>
  }
  return (
    <div className={boardStyle}>
      {board.columns.map((col) => {
        const cards = board.cards.filter((c) => c.columnId === col.id)
        if (cards.length === 0) return null
        return (
          <div key={col.id}>
            <div className={colHeader}>
              {col.name} ({cards.length})
            </div>
            {cards.map((card) => (
              <div key={card.id} className={cardRow}>
                <span>{PRIORITY_DOT[card.priority] ?? '⚪'}</span>
                <span>{card.title}</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

export function KanbanToolView({
  input,
  output,
  status,
}: {
  input: unknown
  output?: ToolResult
  status: string
}) {
  const i = (input ?? {}) as KanbanInput
  const op = i.op ?? 'view'

  // 失败优先于「无看板」：move/add 失败时 metadata 里没有 board，此前整块渲染塌成
  // 一行 op 名，用户既看不到失败原因，也看不出自己那张卡到底有没有移动成功。
  if (output?._tag === 'error' || status === 'error') {
    return (
      <div>
        <span className={opLabel}>kanban/{op}</span>
        <ToolError output={output} status={status} />
      </div>
    )
  }

  // 「输出被截断」不是「没有看板」：超上限的结果以 _tag:'truncated' 返回且没有
  // metadata，board 只能为 null，整块塌成一行 `kanban/view`——用户看不出看板还有
  // 几千张卡（executor 只在 success 分支返回 metadata，见 src/tools/executor.ts）。
  if (output?._tag === 'truncated') {
    return (
      <div>
        <span className={opLabel}>kanban/{op}</span>
        <ToolTruncated output={output} />
      </div>
    )
  }

  // Extract board from output metadata
  let board: KanbanBoard | null = null
  if (output?._tag === 'success') {
    const meta = output.metadata as { board?: KanbanBoard; card?: KanbanCard } | undefined
    if (meta?.board) board = meta.board
  }

  // Show op detail for add/move/delete
  let detailText = ''
  if (op === 'add' && i.title) detailText = `新建: ${i.title}`
  else if (op === 'move' && i.columnId) detailText = `移动到: ${i.columnId}`
  else if (op === 'delete' && i.id) detailText = `删除: ${i.id.slice(0, 8)}`

  return (
    <div>
      <span className={opLabel}>kanban/{op}</span>
      <ToolInlineError output={output} />
      {detailText && <div className={detail}>{detailText}</div>}
      {board && <BoardView board={board} />}
    </div>
  )
}
