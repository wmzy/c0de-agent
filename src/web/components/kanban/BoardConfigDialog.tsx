import { css } from '@linaria/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from 'haze-ui'
import { useState } from 'react'
import { Dialog } from '@/components/Dialog.js'
import { SyncedInput } from '@/components/SyncedControls.js'
import { generateId } from '@/hooks/id.js'
import {
  type KanbanCard,
  type KanbanColumnDef,
  type KanbanLabelDef,
  kanbanAPI,
} from '@/services/kanban.js'
import { btnDanger } from '@/styles/tokens.js'
import { isImeComposing } from '@/utils/ime.js'

const sectionTitle = css`
  font-size: 13px;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
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

/** 行内影响面元信息：这一行涉及多少张卡片。列与标签同口径。 */
const rowMeta = css`
  font-size: 11px;
  color: var(--haze-color-text-secondary);
  flex-shrink: 0;
`

/** 删除标签的影响面确认条：说明「保存后会发生什么」，再让用户确认。
 *  与顶部错误框同一套配色，但不阻塞其它行——用户可继续改列/别的标签。 */
const confirmBar = css`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--haze-color-danger);
  border: 1px solid color-mix(in srgb, var(--haze-color-danger) 45%, transparent);
  background: color-mix(in srgb, var(--haze-color-danger) 8%, transparent);
`

const colorSwatch = css`
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid var(--haze-color-border);
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
  /** 全部卡片：删除列前校验该列内是否仍有卡片（否则卡片静默不可见）。 */
  cards: KanbanCard[]
  onClose: () => void
}

/** 看板配置弹窗：管理列（增删改名）和标签（增删改名改色）。 */
export function BoardConfigDialog({
  projectId,
  columns: initColumns,
  labels: initLabels,
  cards,
  onClose,
}: BoardConfigDialogProps) {
  const qc = useQueryClient()
  const [columns, setColumns] = useState<KanbanColumnDef[]>(initColumns)
  const [labels, setLabels] = useState<KanbanLabelDef[]>(initLabels)
  const [newColumnName, setNewColumnName] = useState('')
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelColor, setNewLabelColor] = useState(LABEL_COLORS[0] ?? '#ef4444')
  const [error, setError] = useState<string | null>(null)
  /** 正在二次确认删除的标签 id：删除标签会跨卡片生效，不能一次点击就落库。 */
  const [confirmLabelId, setConfirmLabelId] = useState<string | null>(null)

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
    onError: (e: unknown) => {
      const msg =
        e && typeof e === 'object' && 'message' in e
          ? String((e as { message: string }).message)
          : '保存失败'
      setError(msg)
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
    // P1-4：列内有卡片时阻止删除（前端即时反馈；后端 409 兜底）
    const count = cards.filter((c) => c.columnId === id).length
    if (count > 0) {
      setError(`该列中仍有 ${count} 张卡片，无法删除。请先移动或删除这些卡片。`)
      return
    }
    setError(null)
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
    setLabels((prev) => prev.map((l) => (l.id === id ? { ...l, name: l.name, ...patch } : l)))
  }
  const removeLabel = (id: string) => {
    setError(null)
    setLabels((prev) => prev.filter((l) => l.id !== id))
  }

  return (
    <Dialog
      onClose={onClose}
      title="看板设置"
      width="min(560px, 92vw)"
      testId="board-config-overlay"
      footer={
        <div className={actions}>
          <Button
            onClick={onClose}
            style={{ minHeight: 'auto', minWidth: 'auto', padding: '6px 12px', fontSize: 12 }}
            variant="ghost"
          >
            取消
          </Button>
          <Button
            variant="solid"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            style={{ minHeight: 'auto', minWidth: 'auto', padding: '6px 12px', fontSize: 12 }}
          >
            保存
          </Button>
        </div>
      }
    >
      {error && (
        <div
          style={{
            color: 'var(--haze-color-danger)',
            fontSize: 12,
            marginBottom: 8,
            padding: '6px 10px',
            border: '1px solid color-mix(in srgb, var(--haze-color-danger) 45%, transparent)',
            borderRadius: 6,
            background: 'color-mix(in srgb, var(--haze-color-danger) 8%, transparent)',
          }}
          data-testid="board-config-error"
        >
          {error}
        </div>
      )}
      {/* 列管理 */}
      <div>
        <div className={sectionTitle}>列</div>
        {columns.map((col) => (
          <div key={col.id} className={row}>
            <SyncedInput
              className={rowInput}
              value={col.name}
              /* 每行都是无名称输入框（无 placeholder、无 label[for]），读屏
               * 逐个念「编辑框」分不清是哪一列。名称取该行当前列名。 */
              aria-label={`列名：${col.name}`}
              onChange={(v) => updateColumnName(col.id, v)}
            />
            <span className={rowMeta}>{cards.filter((c) => c.columnId === col.id).length} 卡</span>
            <Button
              className={`${btnDanger} ${rowBtn}`}
              variant="outline"
              onClick={() => removeColumn(col.id)}
              title={
                cards.some((c) => c.columnId === col.id)
                  ? '该列中仍有卡片，需先移动或删除卡片'
                  : '删除该列'
              }
            >
              删除
            </Button>
          </div>
        ))}
        <div className={row}>
          <SyncedInput
            className={rowInput}
            placeholder="新列名…"
            aria-label="新列名"
            value={newColumnName}
            onChange={(v) => setNewColumnName(v)}
            onKeyDown={(e) => {
              // IME 组合中不拦截：回车确认候选词由输入法处理——不判定会把未确认的
              // 候选当最终输入（列被提前添加）。
              if (isImeComposing(e)) return
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
        {labels.map((l) => {
          // 影响面：保存时服务端会把不在新 labels 里的 labelId 从整块看板
          // **所有**卡片上清掉（src/kanban/store.ts 的悬空引用清理）。卡片弹窗
          // 因此干脆不提供删除入口（见 CardEditDialog），这里是唯一入口——
          // 不显示「有几张卡在用」并二次确认，就是一次点击静默抹掉全板该标签。
          const usage = cards.filter((c) => (c.labels ?? []).includes(l.id)).length
          return (
            <div key={l.id}>
              <div className={row}>
                <SyncedInput
                  type="color"
                  className={colorSwatch}
                  value={l.color}
                  aria-label={`标签颜色：${l.name}`}
                  onChange={(v) => updateLabel(l.id, { color: v })}
                />
                <SyncedInput
                  className={rowInput}
                  value={l.name}
                  aria-label={`标签名：${l.name}`}
                  onChange={(v) => updateLabel(l.id, { name: v })}
                />
                <span className={rowMeta}>{usage > 0 ? `${usage} 卡在用` : '未使用'}</span>
                <Button
                  className={`${btnDanger} ${rowBtn}`}
                  variant="outline"
                  onClick={() => {
                    setError(null)
                    if (usage > 0) setConfirmLabelId(l.id)
                    else removeLabel(l.id)
                  }}
                  title={
                    usage > 0
                      ? `该标签正被 ${usage} 张卡片使用，删除并保存后会被清除`
                      : '删除该标签'
                  }
                  data-testid={`label-delete-${l.id}`}
                >
                  删除
                </Button>
              </div>
              {confirmLabelId === l.id && (
                <div
                  className={confirmBar}
                  role="alert"
                  data-testid={`label-delete-confirm-${l.id}`}
                >
                  <span>
                    「{l.name}」正被 {usage} 张卡片使用；保存后这些卡片上的该标签会被清除。
                  </span>
                  <Button
                    className={rowBtn}
                    variant="solid"
                    onClick={() => {
                      removeLabel(l.id)
                      setConfirmLabelId(null)
                    }}
                    data-testid={`label-delete-confirm-ok-${l.id}`}
                  >
                    确认删除
                  </Button>
                  <Button
                    className={rowBtn}
                    variant="ghost"
                    onClick={() => setConfirmLabelId(null)}
                    data-testid={`label-delete-confirm-cancel-${l.id}`}
                  >
                    取消
                  </Button>
                </div>
              )}
            </div>
          )
        })}
        <div className={row}>
          <SyncedInput
            type="color"
            className={colorSwatch}
            value={newLabelColor}
            aria-label="新标签颜色"
            onChange={(v) => setNewLabelColor(v)}
          />
          <SyncedInput
            className={rowInput}
            placeholder="新标签名…"
            aria-label="新标签名"
            value={newLabelName}
            onChange={(v) => setNewLabelName(v)}
            onKeyDown={(e) => {
              // IME 组合中不拦截（同上）：候选未确认时不添加标签。
              if (isImeComposing(e)) return
              if (e.key === 'Enter') addLabel()
            }}
          />
          <button type="button" className={addBtn} onClick={addLabel}>
            + 添加标签
          </button>
        </div>
      </div>

      {saveMutation.isError && (
        <div style={{ color: 'var(--haze-color-danger)', fontSize: 12 }}>
          保存失败：{(saveMutation.error as Error)?.message}
        </div>
      )}
    </Dialog>
  )
}
