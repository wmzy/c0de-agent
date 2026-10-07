import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { css } from '@linaria/core'
import { Button } from 'haze-ui'
import { useState } from 'react'
import { SyncedInput } from '@/components/SyncedControls.js'
import type {
  KanbanCard as KanbanCardType,
  KanbanLabelDef,
  KanbanPriority,
} from '@/services/kanban.js'
import { isImeComposing } from '@/utils/ime.js'

// ── Styles ─────────────────────────────────────────────────

const PRIORITY_COLORS: Record<KanbanPriority, string> = {
  high: 'var(--haze-color-danger)',
  medium: '#eab308',
  low: 'var(--haze-color-text-secondary)',
}

const card = css`
  background: var(--haze-color-bg-subtle);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 8px 10px;
  cursor: grab;
  transition: border-color 0.15s, box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: auto;

  &:hover {
    border-color: var(--haze-color-text-secondary);
  }
  &:active {
    cursor: grabbing;
  }
`

const cardDragging = css`
  opacity: 0.5;
  border-color: var(--haze-color-primary);
  box-shadow: 0 0 12px color-mix(in srgb, var(--haze-color-primary) 30%, transparent);
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

  /*
   * dnd-kit 的拖拽由 listeners.onPointerDown 激活（PointerSensor 的 activator）。
   * 原实现先 `{...listeners}` 再写 `onPointerDown={e => e.stopPropagation()}`，
   * 后者把前者的 onPointerDown 整个覆盖掉——激活器消失，PointerSensor 永不启动，
   * 卡片拖不动（实测：按下并逐帧移动 25 步，卡片 transform 恒为空、坐标不变）。
   *
   * stopPropagation 本身仍要保留（避免指针事件冒泡出卡片），但必须先委托给
   * dnd-kit 的原始 handler：拆出 onPointerDown 单独组合，其余 listeners 原样展开。
   */
  const { onPointerDown: activateDrag, ...restListeners } = listeners ?? {}

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
      {...restListeners}
      onClick={(e) => {
        // 只在非拖拽时触发点击
        if (!isDragging) {
          e.stopPropagation()
          onClick()
        }
      }}
      onPointerDown={(e) => {
        // 先交给 dnd-kit 启动拖拽，再阻断冒泡（顺序不能反：漏掉前者卡片就拖不动）
        activateDrag?.(e)
        e.stopPropagation()
      }}
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
  background: var(--haze-color-bg);
  border-radius: 8px;
  border: 1px solid var(--haze-color-border);
  overflow: hidden;
`

const columnHeader = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--haze-color-border);
  flex-shrink: 0;
`

const columnName = css`
  font-size: 12px;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
`

const columnCount = css`
  font-size: 11px;
  color: var(--haze-color-text-secondary);
  background: var(--haze-color-bg-subtle);
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
  background: color-mix(in srgb, var(--haze-color-primary) 8%, var(--haze-color-bg));
`

const addCardBtn = css`
  min-height: auto;
  min-width: auto;
  padding: 4px 8px;
  font-size: 12px;
  text-align: left;
  color: var(--haze-color-text-secondary);
  background: transparent;
  border: 1px dashed var(--haze-color-border);
  border-radius: 4px;
  &:hover {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
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

/** 新建失败的就地反馈：错误条离该列的输入框最近，用户不必在整页里找。 */
const quickAddError = css`
  margin-top: 4px;
  font-size: 12px;
  color: var(--haze-color-danger);
  word-break: break-word;
`

type ColumnProps = {
  column: { id: string; name: string }
  cards: KanbanCardType[]
  labels: KanbanLabelDef[]
  onCardClick: (card: KanbanCardType) => void
  /** 新建卡片；失败时 reject（调用方保留草稿并就地显示原因）。 */
  onQuickAdd: (title: string) => Promise<void>
}

/** 一个看板列：droppable + sortable context + 快速新建。 */
export function KanbanColumn({ column: col, cards, labels, onCardClick, onQuickAdd }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: col.id,
    data: { columnId: col.id, type: 'column' },
  })

  const [isAdding, setIsAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // 只在成功后清空草稿并收起输入框：此前无条件清空 + 关闭，请求失败时输入框
  // 消失、没有新卡片、整页无提示，用户刚打的标题永久丢失（只能重打一遍），
  // 而失败在界面上与「成功但卡片没出现」完全等价。失败时保留草稿与输入框，
  // 就地给出后端的失败原因，改一下再按回车即可重试。
  const submit = async () => {
    const t = draft.trim()
    if (!t || pending) return
    setPending(true)
    setAddError(null)
    try {
      await onQuickAdd(t)
      setDraft('')
      setIsAdding(false)
    } catch (err) {
      // APIError 是真正的 Error（services/api.ts 的 ApiErrorImpl），message 即后端文案；
      // 结构化取优先、instanceof 兜底，不会渲染成 [object Object]。
      const message =
        (err as { message?: string } | null)?.message ?? (err instanceof Error ? err.message : null)
      setAddError(message ?? '新建卡片失败，请重试')
    } finally {
      setPending(false)
    }
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
          <div>
            <div className={quickAddRow}>
              <SyncedInput
                className={quickAddInput}
                value={draft}
                onChange={(v) => {
                  setDraft(v)
                  // 用户已经在改标题 → 上一轮的失败提示不再适用
                  if (addError) setAddError(null)
                }}
                onKeyDown={(e) => {
                  // IME 组合中不拦截：回车确认候选词/ESC 取消候选由输入法处理——
                  // 不判定会把未确认的候选当卡片标题提交（并清空输入框）。
                  if (isImeComposing(e)) return
                  if (e.key === 'Enter') void submit()
                  if (e.key === 'Escape') {
                    setIsAdding(false)
                    setDraft('')
                    setAddError(null)
                  }
                }}
                placeholder="卡片标题…"
              />
              <Button
                className={quickAddBtn}
                onClick={() => void submit()}
                variant="solid"
                disabled={pending}
              >
                {pending ? '添加中…' : '添加'}
              </Button>
            </div>
            {addError && (
              <div className={quickAddError} role="alert" data-testid={`quick-add-error-${col.id}`}>
                {addError}
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            className={addCardBtn}
            // 重开时清掉上一轮的失败原因：请求在途时按 Esc 会收起输入框，但那条失败
            // 结果稍后才落地，重新打开就会看到一条描述着已被放弃的标题的报错。
            onClick={() => {
              setAddError(null)
              setIsAdding(true)
            }}
          >
            + 新建卡片
          </button>
        )}
      </div>
    </div>
  )
}
