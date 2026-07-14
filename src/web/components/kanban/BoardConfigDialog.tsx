import { css } from '@linaria/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { generateId } from '../../hooks/id.js'
import { type KanbanColumnDef, type KanbanLabelDef, kanbanAPI } from '../../services/kanban.js'

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
  width: min(560px, 92vw);
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  gap: 16px;
`

const titleStyle = css`
  font-size: 16px;
  font-weight: 600;
`

const sectionTitle = css`
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 4px;
`

const row = css`
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
`

const rowInput = css`
  flex: 1;
  min-height: auto;
  padding: 4px 8px;
  font-size: 13px;
`

const rowBtn = css`
  min-height: auto;
  min-width: auto;
  padding: 4px 8px;
  font-size: 12px;
`

const colorSwatch = css`
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid var(--border);
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  background: none;
`

const addBtn = css`
  min-height: auto;
  min-width: auto;
  padding: 4px 12px;
  font-size: 12px;
  align-self: flex-start;
`

const actions = css`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
`

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

type BoardConfigDialogProps = {
  projectId: string
  columns: KanbanColumnDef[]
  labels: KanbanLabelDef[]
  onClose: () => void
}

/** 看板配置弹窗：管理列（增删改名）和标签（增删改名改色）。 */
export function BoardConfigDialog({
  projectId,
  columns: initColumns,
  labels: initLabels,
  onClose,
}: BoardConfigDialogProps) {
  const qc = useQueryClient()
  const [columns, setColumns] = useState<KanbanColumnDef[]>(initColumns)
  const [labels, setLabels] = useState<KanbanLabelDef[]>(initLabels)
  const [newColumnName, setNewColumnName] = useState('')
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelColor, setNewLabelColor] = useState(LABEL_COLORS[0] ?? '#ef4444')

  const saveMutation = useMutation({
    mutationFn: () =>
      kanbanAPI.updateBoard(projectId, {
        columns,
        labels,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kanban', projectId] })
      onClose()
    },
  })

  // 列操作
  const addColumn = () => {
    if (!newColumnName.trim()) return
    setColumns((prev) => [...prev, { id: generateId(), name: newColumnName.trim() }])
    setNewColumnName('')
  }
  const updateColumnName = (id: string, name: string) => {
    setColumns((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)))
  }
  const removeColumn = (id: string) => {
    setColumns((prev) => prev.filter((c) => c.id !== id))
  }

  // 标签操作
  const addLabel = () => {
    if (!newLabelName.trim()) return
    setLabels((prev) => [
      ...prev,
      { id: generateId(), name: newLabelName.trim(), color: newLabelColor },
    ])
    setNewLabelName('')
  }
  const updateLabel = (id: string, patch: Partial<KanbanLabelDef>) => {
    setLabels((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }
  const removeLabel = (id: string) => {
    setLabels((prev) => prev.filter((l) => l.id !== id))
  }

  return (
    <div className={overlay} role="presentation" data-testid="board-config-overlay">
      <div className={dialog}>
        <div className={titleStyle}>看板设置</div>

        {/* 列管理 */}
        <div>
          <div className={sectionTitle}>列</div>
          {columns.map((col) => (
            <div key={col.id} className={row}>
              <input
                className={rowInput}
                value={col.name}
                onChange={(e) => updateColumnName(col.id, e.target.value)}
              />
              <button
                type="button"
                data-variant="danger"
                className={rowBtn}
                onClick={() => removeColumn(col.id)}
              >
                删除
              </button>
            </div>
          ))}
          <div className={row}>
            <input
              className={rowInput}
              placeholder="新列名…"
              value={newColumnName}
              onChange={(e) => setNewColumnName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addColumn()
              }}
            />
            <button type="button" className={addBtn} onClick={addColumn}>
              + 添加列
            </button>
          </div>
        </div>

        {/* 标签管理 */}
        <div>
          <div className={sectionTitle}>标签</div>
          {labels.map((l) => (
            <div key={l.id} className={row}>
              <input
                type="color"
                className={colorSwatch}
                value={l.color}
                onChange={(e) => updateLabel(l.id, { color: e.target.value })}
              />
              <input
                className={rowInput}
                value={l.name}
                onChange={(e) => updateLabel(l.id, { name: e.target.value })}
              />
              <button
                type="button"
                data-variant="danger"
                className={rowBtn}
                onClick={() => removeLabel(l.id)}
              >
                删除
              </button>
            </div>
          ))}
          <div className={row}>
            <input
              type="color"
              className={colorSwatch}
              value={newLabelColor}
              onChange={(e) => setNewLabelColor(e.target.value)}
            />
            <input
              className={rowInput}
              placeholder="新标签名…"
              value={newLabelName}
              onChange={(e) => setNewLabelName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addLabel()
              }}
            />
            <button type="button" className={addBtn} onClick={addLabel}>
              + 添加标签
            </button>
          </div>
        </div>

        {saveMutation.isError && (
          <div style={{ color: 'var(--error)', fontSize: 12 }}>
            保存失败：{(saveMutation.error as Error)?.message}
          </div>
        )}

        <div className={actions}>
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
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            style={{ minHeight: 'auto', minWidth: 'auto', padding: '6px 12px', fontSize: 12 }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
