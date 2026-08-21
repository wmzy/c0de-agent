import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { css } from '@linaria/core'
import { useState } from 'react'
import type {
  KanbanCard as KanbanCardType,
  KanbanLabelDef,
  KanbanPriority,
} from '../../services/kanban.js'

// ── Styles ─────────────────────────────────────────────────

const PRIORITY_COLORS: Record<KanbanPriority, string> = {
  high: 'var(--error)',
  medium: '#eab308',
  low: 'var(--text-secondary)',
}

const card = css`
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  cursor: grab;
  transition: border-color 0.15s, box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: auto;

  &:hover {
    border-color: var(--text-secondary);
  }
  &:active {
    cursor: grabbing;
  }
`

const cardDragging = css`
  opacity: 0.5;
  border-color: var(--primary);
  box-shadow: 0 0 12px color-mix(in srgb, var(--primary) 30%, transparent);
`

const cardHeader = css`
  display: flex;
  align-items: flex-start;
  gap: 6px;
`

const priorityDot = css`
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 6px;
`

const cardTitle = css`
  font-size: 13px;
  line-height: 1.4;
  flex: 1;
  word-break: break-word;
`

const labelsRow = css`
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
`

const labelTag = css`
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 500;
  line-height: 1.4;
`

const labelDot = css`
  width: 6px;
  height: 6px;
  border-radius: 50%;
`

// ── Single card (draggable) ───────────────────────────────

type CardProps = {
  card: KanbanCardType
  labels: KanbanLabelDef[]
  onClick: () => void
}

function DraggableCard({ card: c, labels, onClick }: CardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: c.id,
    data: { columnId: c.columnId, type: 'card' },
  })

  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
  }

  const cardLabels = c.labels
    .map((id) => labels.find((l) => l.id === id))
    .filter((l): l is KanbanLabelDef => !!l)

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: dnd-kit attributes provides keyboard handlers
    // biome-ignore lint/a11y/noStaticElementInteractions: dnd-kit draggable role is set via attributes spread
    <div
      ref={setNodeRef}
      style={style}
      className={`${card} ${isDragging ? cardDragging : ''}`}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        // 只在非拖拽时触发点击
        if (!isDragging) {
          e.stopPropagation()
          onClick()
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      data-testid={`kanban-card-${c.id}`}
    >
      <div className={cardHeader}>
        <span
          className={priorityDot}
          style={{ background: PRIORITY_COLORS[c.priority] }}
          title={`优先级: ${c.priority}`}
        />
        <span className={cardTitle}>{c.title}</span>
      </div>
      {cardLabels.length > 0 && (
        <div className={labelsRow}>
          {cardLabels.map((l) => (
            <span
              key={l.id}
              className={labelTag}
              style={{
                color: l.color,
                background: `color-mix(in srgb, ${l.color} 15%, transparent)`,
              }}
            >
              <span className={labelDot} style={{ background: l.color }} />
              {l.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Column (droppable + sortable context) ──────────────────

const column = css`
  display: flex;
  flex-direction: column;
  width: 280px;
  min-width: 280px;
  height: 100%;
  background: var(--bg);
  border-radius: 8px;
  border: 1px solid var(--border);
  overflow: hidden;
`

const columnHeader = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
`

const columnName = css`
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
`

const columnCount = css`
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-radius: 3px;
  padding: 1px 6px;
  font-variant-numeric: tabular-nums;
`

const columnBody = css`
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
`

const columnDropActive = css`
  background: color-mix(in srgb, var(--primary) 8%, var(--bg));
`

const addCardBtn = css`
  min-height: auto;
  min-width: auto;
  padding: 4px 8px;
  font-size: 12px;
  text-align: left;
  color: var(--text-secondary);
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 4px;
  &:hover {
    border-color: var(--primary);
    color: var(--primary);
  }
`

const quickAddRow = css`
  display: flex;
  gap: 4px;
`

const quickAddInput = css`
  flex: 1;
  min-height: auto;
  padding: 4px 8px;
  font-size: 13px;
`

const quickAddBtn = css`
  min-height: auto;
  min-width: auto;
  padding: 4px 10px;
  font-size: 12px;
`

type ColumnProps = {
  column: { id: string; name: string }
  cards: KanbanCardType[]
  labels: KanbanLabelDef[]
  onCardClick: (card: KanbanCardType) => void
  onQuickAdd: (title: string) => void
}

/** 一个看板列：droppable + sortable context + 快速新建。 */
export function KanbanColumn({ column: col, cards, labels, onCardClick, onQuickAdd }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: col.id,
    data: { columnId: col.id, type: 'column' },
  })

  const [isAdding, setIsAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const submit = () => {
    const t = draft.trim()
    if (t) onQuickAdd(t)
    setDraft('')
    setIsAdding(false)
  }

  return (
    <div
      ref={setNodeRef}
      className={`${column} ${isOver ? columnDropActive : ''}`}
      data-column-id={col.id}
    >
      <div className={columnHeader}>
        <span className={columnName}>{col.name}</span>
        <span className={columnCount}>{cards.length}</span>
      </div>
      <div className={columnBody}>
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((c) => (
            <DraggableCard key={c.id} card={c} labels={labels} onClick={() => onCardClick(c)} />
          ))}
        </SortableContext>

        {/* 空列不渲染常驻占位文案：多列空白时逐列重复「拖动卡片到此处」是视觉噪音；
            可拖入性由列容器本身（columnDropActive 悬停高亮）与「+ 新建卡片」行动点表达。 */}

        {isAdding ? (
          <div className={quickAddRow}>
            <input
              className={quickAddInput}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') {
                  setIsAdding(false)
                  setDraft('')
                }
              }}
              placeholder="卡片标题…"
            />
            <button type="button" data-variant="primary" className={quickAddBtn} onClick={submit}>
              添加
            </button>
          </div>
        ) : (
          <button type="button" className={addCardBtn} onClick={() => setIsAdding(true)}>
            + 新建卡片
          </button>
        )}
      </div>
    </div>
  )
}
