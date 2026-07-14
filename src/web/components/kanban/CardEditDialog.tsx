import { css } from '@linaria/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { type KanbanLabelDef, type KanbanPriority, kanbanAPI } from '../../services/kanban.js'

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`

const dialog = css`
  background: var(--bg);
  border-radius: 8px;
  padding: 20px;
  width: min(520px, 92vw);
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  gap: 12px;
`

const titleStyle = css`
  font-size: 16px;
  font-weight: 600;
`

const field = css`
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const label = css`
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  min-height: auto;
`

const titleInput = css`
  font-size: 15px;
  font-weight: 500;
  min-height: auto;
  padding: 6px 10px;
`

const descTextarea = css`
  min-height: auto;
  font-size: 13px;
  resize: vertical;
  min-height: 80px;
`

const priorityRow = css`
  display: flex;
  gap: 6px;
`

const priorityBtn = css`
  min-height: auto;
  min-width: auto;
  padding: 4px 12px;
  font-size: 12px;
  border-radius: 4px;
`

const labelsGrid = css`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`

const labelChip = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  min-height: auto;
  min-width: auto;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  &:hover {
    filter: brightness(1.1);
  }
`

const labelChipSelected = css`
  border-color: currentColor;
`

const labelDot = css`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
`

const actions = css`
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
`

const actionsRight = css`
  display: flex;
  gap: 8px;
`

const PRIORITY_COLORS: Record<KanbanPriority, string> = {
  high: 'var(--error)',
  medium: 'var(--warning, #eab308)',
  low: 'var(--text-secondary)',
}

const PRIORITY_LABELS: Record<KanbanPriority, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

type CardEditDialogProps = {
  projectId: string
  cardId: string
  initialTitle: string
  initialDescription: string | null
  initialPriority: KanbanPriority
  initialLabels: string[]
  boardLabels: KanbanLabelDef[]
  onClose: () => void
}

/** 卡片编辑弹窗：编辑标题、描述、优先级、标签。 */
export function CardEditDialog({
  projectId,
  cardId,
  initialTitle,
  initialDescription,
  initialPriority,
  initialLabels,
  boardLabels,
  onClose,
}: CardEditDialogProps) {
  const qc = useQueryClient()
  const [titleVal, setTitleVal] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription ?? '')
  const [priority, setPriority] = useState<KanbanPriority>(initialPriority)
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set(initialLabels))

  // Escape 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const mutation = useMutation({
    mutationFn: (patch: Parameters<typeof kanbanAPI.updateCard>[2]) =>
      kanbanAPI.updateCard(projectId, cardId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kanban', projectId] })
      onClose()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => kanbanAPI.deleteCard(projectId, cardId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kanban', projectId] })
      onClose()
    },
  })

  const toggleLabel = (id: string) => {
    setSelectedLabels((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const save = () => {
    if (!titleVal.trim()) return
    mutation.mutate({
      title: titleVal.trim(),
      description: description.trim() || null,
      priority,
      labels: [...selectedLabels],
    })
  }

  return (
    <div className={overlay} role="presentation" data-testid="card-edit-overlay">
      <div className={dialog}>
        <div className={titleStyle}>编辑卡片</div>

        <div className={field}>
          <span className={label}>标题</span>
          <input
            className={titleInput}
            value={titleVal}
            onChange={(e) => setTitleVal(e.target.value)}
            data-testid="card-title-input"
          />
        </div>

        <div className={field}>
          <span className={label}>描述</span>
          <textarea
            className={descTextarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="添加详细描述…"
            data-testid="card-desc-input"
          />
        </div>

        <div className={field}>
          <span className={label}>优先级</span>
          <div className={priorityRow}>
            {(Object.keys(PRIORITY_COLORS) as KanbanPriority[]).map((p) => (
              <button
                key={p}
                type="button"
                className={priorityBtn}
                data-variant={priority === p ? 'primary' : 'ghost'}
                onClick={() => setPriority(p)}
                style={{ color: priority === p ? '#fff' : PRIORITY_COLORS[p] }}
              >
                {PRIORITY_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        {boardLabels.length > 0 && (
          <div className={field}>
            <span className={label}>标签</span>
            <div className={labelsGrid}>
              {boardLabels.map((l) => {
                const selected = selectedLabels.has(l.id)
                return (
                  <button
                    key={l.id}
                    type="button"
                    className={`${labelChip} ${selected ? labelChipSelected : ''}`}
                    style={{ color: l.color }}
                    onClick={() => toggleLabel(l.id)}
                  >
                    <span className={labelDot} style={{ background: l.color }} />
                    {l.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {(mutation.isError || deleteMutation.isError) && (
          <div style={{ color: 'var(--error)', fontSize: 12 }}>
            操作失败：
            {(mutation.error as Error)?.message ?? (deleteMutation.error as Error)?.message}
          </div>
        )}

        <div className={actions}>
          <button
            type="button"
            data-variant="danger"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            style={{ minHeight: 'auto', minWidth: 'auto', padding: '6px 12px', fontSize: 12 }}
          >
            删除
          </button>
          <div className={actionsRight}>
            <button
              type="button"
              data-variant="ghost"
              onClick={onClose}
              style={{ minHeight: 'auto', minWidth: 'auto', padding: '6px 12px', fontSize: 12 }}
            >
              取消
            </button>
            <button
              type="button"
              data-variant="primary"
              onClick={save}
              disabled={mutation.isPending || !titleVal.trim()}
              style={{ minHeight: 'auto', minWidth: 'auto', padding: '6px 12px', fontSize: 12 }}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
