import { css } from '@linaria/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { generateId } from '../../hooks/id.js'
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
  align-items: stretch;
  border-radius: 4px;
  font-size: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
`

const labelChipSelected = css`
  border-color: currentColor;
`

const labelChipMain = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 8px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  color: inherit;
  min-height: auto;
  min-width: auto;
  &:hover {
    filter: brightness(1.1);
  }
`

const labelChipDel = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px 6px 3px 2px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  color: var(--text-secondary);
  min-height: auto;
  min-width: auto;
  &:hover {
    color: var(--error);
  }
`

const labelDot = css`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
`

const labelHint = css`
  font-size: 12px;
  color: var(--text-secondary);
  font-style: italic;
`

const labelCreateRow = css`
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
`

const colorSwatch = css`
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: 1px solid var(--border);
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  background: none;
`

const labelNameInput = css`
  flex: 1;
  min-height: auto;
  padding: 3px 8px;
  font-size: 12px;
`

const labelAddBtn = css`
  min-height: auto;
  min-width: auto;
  padding: 3px 10px;
  font-size: 12px;
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

const LABEL_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
]

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
  const [allLabels, setAllLabels] = useState<KanbanLabelDef[]>(boardLabels)
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelColor, setNewLabelColor] = useState(LABEL_COLORS[0] ?? '#ef4444')

  // Escape 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const saveMutation = useMutation({
    mutationFn: async () => {
      // 若标签有增删变化，先持久化到 board 配置
      const boardIds = new Set(boardLabels.map((l) => l.id))
      const labelsChanged =
        allLabels.length !== boardLabels.length || allLabels.some((l) => !boardIds.has(l.id))
      if (labelsChanged) {
        await kanbanAPI.updateBoard(projectId, { labels: allLabels })
      }
      return kanbanAPI.updateCard(projectId, cardId, {
        title: titleVal.trim(),
        description: description.trim() || null,
        priority,
        labels: [...selectedLabels],
      })
    },
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

  const addLabel = () => {
    const name = newLabelName.trim()
    if (!name) return
    const id = generateId()
    setAllLabels((prev) => [...prev, { id, name, color: newLabelColor }])
    setSelectedLabels((prev) => new Set(prev).add(id))
    setNewLabelName('')
  }

  const removeLabel = (id: string) => {
    setAllLabels((prev) => prev.filter((l) => l.id !== id))
    setSelectedLabels((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const save = () => {
    if (!titleVal.trim()) return
    saveMutation.mutate()
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

        <div className={field}>
          <span className={label}>标签</span>
          {allLabels.length > 0 ? (
            <div className={labelsGrid}>
              {allLabels.map((l) => {
                const selected = selectedLabels.has(l.id)
                return (
                  <span
                    key={l.id}
                    className={`${labelChip} ${selected ? labelChipSelected : ''}`}
                    style={{ color: l.color }}
                  >
                    <button
                      type="button"
                      className={labelChipMain}
                      onClick={() => toggleLabel(l.id)}
                    >
                      <span className={labelDot} style={{ background: l.color }} />
                      {l.name}
                    </button>
                    <button
                      type="button"
                      className={labelChipDel}
                      onClick={() => removeLabel(l.id)}
                      aria-label={`删除标签 ${l.name}`}
                    >
                      ×
                    </button>
                  </span>
                )
              })}
            </div>
          ) : (
            <span className={labelHint}>暂无标签，可在下方创建</span>
          )}
          <div className={labelCreateRow}>
            <input
              type="color"
              className={colorSwatch}
              value={newLabelColor}
              onChange={(e) => setNewLabelColor(e.target.value)}
              aria-label="标签颜色"
            />
            <input
              className={labelNameInput}
              placeholder="新标签名…"
              value={newLabelName}
              onChange={(e) => setNewLabelName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addLabel()
              }}
            />
            <button type="button" className={labelAddBtn} onClick={addLabel}>
              + 添加
            </button>
          </div>
        </div>

        {(saveMutation.isError || deleteMutation.isError) && (
          <div style={{ color: 'var(--error)', fontSize: 12 }}>
            操作失败：
            {(saveMutation.error as Error)?.message ?? (deleteMutation.error as Error)?.message}
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
              disabled={saveMutation.isPending || !titleVal.trim()}
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
