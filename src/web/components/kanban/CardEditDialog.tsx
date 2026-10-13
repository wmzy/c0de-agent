import { css } from '@linaria/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from 'haze-ui'
import { useState } from 'react'
import { Dialog } from '@/components/Dialog.js'
import { SyncedInput, SyncedTextarea } from '@/components/SyncedControls.js'
import { generateId } from '@/hooks/id.js'
import { type KanbanLabelDef, type KanbanPriority, kanbanAPI } from '@/services/kanban.js'
import { btnDanger } from '@/styles/tokens.js'
import { isImeComposing } from '@/utils/ime.js'

const field = css`
  display: flex;
  flex-direction: column;
  gap: 4px;
`

/** fieldset 的浏览器默认边框/内边距/最小宽度要抹掉，否则比 div 版多一圈框。
 * legend 默认在边框上，正好靠上面的 display:block 归位到字段流的顶部。 */
const fieldSet = css`
  border: none;
  margin: 0;
  padding: 0;
  min-width: 0;
`

const label = css`
  font-size: 12px;
  font-weight: 500;
  color: var(--haze-color-text-secondary);
  min-height: auto;
  display: block;
  padding: 0;
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

/*
 * 优先级选中态：语义色实底 + 对应的 -on-solid 前景色。
 *
 * 此前选中只由内联 `color:#fff` 表达：priorityBtn 只有尺寸，data-variant 全仓
 * 没有任何选择器消费，底色来自 global.ts 的裸按钮兜底（--haze-color-bg-subtle，
 * light ≈ oklch(0.979 0 0) #fbfbfb）。于是 light 主题下被选中的那一档是白字压
 * 近白底（实测 1.06:1），「高/中/低」里恰好有一档看不见；且选中与未选中除这行
 * 字色外没有任何视觉差异，aria-pressed 只对读屏有效——用户无法确认卡片当前是
 * 哪个优先级。
 *
 * 前景色走 token 而非写死 #fff：语义色是按「当文字色」调校的，当实底时两侧主题
 * 的前景要求相反（见 global.ts 的 --c0de-*-on-solid）。
 *
 * 每档都要带一条同形状的 hover：global.ts 的
 * :where(button):hover:not(:disabled):not([aria-disabled='true']) 特异度是 (0,3,0)，
 * 会盖掉裸类的 (0,1,0)——鼠标停在选中项上时实底被换成近白的半透明底（color-mix
 * 百分比不足 100% 会留 12% 透明），白字照旧，选中档在悬停时再次不可读。
 * 同形状写一遍即可：同特异度按源序，组件样式晚于 global.ts 求值。
 */
const prioritySelectedHigh = css`
  background: var(--haze-color-danger);
  border-color: var(--haze-color-danger);
  color: var(--c0de-danger-on-solid, #fff);

  &:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--haze-color-danger);
    border-color: var(--haze-color-danger);
    color: var(--c0de-danger-on-solid, #fff);
  }
`

const prioritySelectedMedium = css`
  background: var(--haze-color-warning, #eab308);
  border-color: var(--haze-color-warning, #eab308);
  color: var(--c0de-warning-on-solid, #fff);

  &:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--haze-color-warning, #eab308);
    border-color: var(--haze-color-warning, #eab308);
    color: var(--c0de-warning-on-solid, #fff);
  }
`

/** 「低」是中性灰实底：前景同样按底色明暗取 token（dark 近黑 / light 白字）。 */
const prioritySelectedLow = css`
  background: var(--haze-color-text-secondary);
  border-color: var(--haze-color-text-secondary);
  color: var(--c0de-primary-on-solid, #fff);

  &:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--haze-color-text-secondary);
    border-color: var(--haze-color-text-secondary);
    color: var(--c0de-primary-on-solid, #fff);
  }
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
  border: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg-subtle);
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
  color: var(--haze-color-text-secondary);
  min-height: auto;
  min-width: auto;
  &:hover {
    color: var(--haze-color-danger);
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
  color: var(--haze-color-text-secondary);
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
  border: 1px solid var(--haze-color-border);
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
`

const actionsRight = css`
  display: flex;
  gap: 8px;
`

/** 未选中态前景色：语义色当文字色用。danger 在 dark 主题下按原 token 只有
 *  4.43:1（实测），差一点够不到 AA——走 global.ts 为「语义色压在 bg-subtle 上」
 *  备好的 --c0de-danger-on-surface（dark 实测 5.31）。 */
const PRIORITY_COLORS: Record<KanbanPriority, string> = {
  high: 'var(--c0de-danger-on-surface, var(--haze-color-danger))',
  medium: 'var(--haze-color-warning, #eab308)',
  low: 'var(--haze-color-text-secondary)',
}

const PRIORITY_LABELS: Record<KanbanPriority, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

/** 选中态样式：按档位取语义色实底（见 prioritySelected* 的注释）。 */
const PRIORITY_SELECTED: Record<KanbanPriority, string> = {
  high: prioritySelectedHigh,
  medium: prioritySelectedMedium,
  low: prioritySelectedLow,
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

  // 已在看板配置里持久化的标签 id。本弹窗只负责「这张卡片带哪些标签」与
  // 「新增标签」；标签定义的改名/删除属于看板设置（BoardConfigDialog）。
  const persistedLabelIds = new Set(boardLabels.map((l) => l.id))

  const saveMutation = useMutation({
    mutationFn: async () => {
      // 若标签有增删变化，先持久化到 board 配置。
      // 只会「多」不会「少」：本弹窗不提供删除已持久化标签的入口（见下方标签
      // 网格），因此 allLabels 恒为 boardLabels 的超集，updateBoard 触发的
      // store 悬空引用清理不会删掉任何现有标签。
      const labelsChanged =
        allLabels.length !== boardLabels.length ||
        allLabels.some((l) => !persistedLabelIds.has(l.id))
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

  // P1 删除防护：卡片删除是物理删除且不可恢复（会话/看板板均有回收站，唯独卡片没有），
  // 且卡片 id 被 agent 引用——误删后 agent 后续 update/move 直接报错。二次确认（armed 态）。
  // 确认态无需手动重置：父组件按 cardId 重挂载本对话框（key），换卡/重开天然回到初始态。
  const [deleteArmed, setDeleteArmed] = useState(false)
  const onDeleteClick = () => {
    if (!deleteArmed) {
      setDeleteArmed(true)
      return
    }
    deleteMutation.mutate()
  }

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
    // 已持久化的标签不在此处删除：updateBoard 的悬空引用清理会把该 labelId
    // 从**整块看板所有卡片**上抹掉，而弹窗标题只有「编辑卡片」。实测在卡片甲
    // 里点某个标签的「×」并保存，卡片乙身上同一个标签也一起消失（后端 board
    // labels 也少了一条）——用户看不到任何跨卡片影响的提示。删除标签定义请走
    // 看板设置；这里只允许撤销「刚添加、尚未保存」的标签。
    if (persistedLabelIds.has(id)) return
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

  // 保存/删除在飞时不许关闭：失败原因（操作失败：…）只画在弹窗内部，Esc/✕/点背景/
  // 「取消」一旦卸载弹窗，原因随之消失——用户看到「弹窗自己关了」只会读成已保存
  // （卡片其实还是旧标题），删除路径同理（以为删了、其实没删）。与 BoardConfigDialog
  // / CommitReviewDialog / AddProjectDialog 同一口径。
  const busy = saveMutation.isPending || deleteMutation.isPending
  const dismiss = () => {
    if (busy) return
    onClose()
  }

  return (
    <Dialog
      onClose={dismiss}
      closeDisabled={busy}
      title="编辑卡片"
      width="min(520px, 92vw)"
      testId="card-edit-overlay"
      footer={
        <div className={actions}>
          <Button
            className={btnDanger}
            variant="outline"
            onClick={onDeleteClick}
            disabled={deleteMutation.isPending}
            style={{ minHeight: 'auto', minWidth: 'auto', padding: '6px 12px', fontSize: 12 }}
            data-testid="card-delete-btn"
          >
            {deleteArmed ? '确认删除？（不可恢复）' : '删除'}
          </Button>
          <div className={actionsRight}>
            <Button
              variant="ghost"
              onClick={dismiss}
              disabled={busy}
              style={{ minHeight: 'auto', minWidth: 'auto', padding: '6px 12px', fontSize: 12 }}
            >
              取消
            </Button>
            <Button
              variant="solid"
              onClick={save}
              disabled={saveMutation.isPending || !titleVal.trim()}
              style={{ minHeight: 'auto', minWidth: 'auto', padding: '6px 12px', fontSize: 12 }}
            >
              保存
            </Button>
          </div>
        </div>
      }
    >
      <div className={field}>
        <span className={label}>标题</span>
        <SyncedInput
          className={titleInput}
          value={titleVal}
          onChange={(v) => setTitleVal(v)}
          /* 这里的「标题/描述」是 span 而非 label[for]，读屏不会把它与控件
           * 关联，控件本身也没有 placeholder——无名称输入框。 */
          aria-label="标题"
          data-testid="card-title-input"
        />
      </div>

      <div className={field}>
        <span className={label}>描述</span>
        <SyncedTextarea
          className={descTextarea}
          value={description}
          onChange={(v) => setDescription(v)}
          placeholder="添加详细描述…"
          aria-label="描述"
          data-testid="card-desc-input"
        />
      </div>

      {/* 互斥的一组开关：aria-pressed 表达「当前是哪一档」，与项目内其它
          切换组（终端标签、视图切换、回收站开关）口径一致。
          更早一步这里只有颜色差异（且选中是近白底上的白字，肉眼与对比度双双
          失效），读屏播报为「高 按钮 / 中 按钮 / 低 按钮」三个无状态按钮——
          当前优先级完全丢失。用 fieldset/legend 承载分组语义（等价于 role=group，
          且读屏进入分组时会播报 legend）；视觉侧的选中态见 prioritySelected*。 */}
      <fieldset className={`${field} ${fieldSet}`}>
        <legend className={label}>优先级</legend>
        <div className={priorityRow}>
          {(Object.keys(PRIORITY_COLORS) as KanbanPriority[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`${priorityBtn} ${priority === p ? PRIORITY_SELECTED[p] : ''}`}
              aria-pressed={priority === p}
              onClick={() => setPriority(p)}
              data-testid={`card-priority-${p}`}
              // 选中时前景色由 PRIORITY_SELECTED 的实底类决定，行内色必须让位；
              // 未选中时按档位语义色当文字色。
              style={{ color: priority === p ? undefined : PRIORITY_COLORS[p] }}
            >
              {PRIORITY_LABELS[p]}
            </button>
          ))}
        </div>
      </fieldset>

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
                  {/* 选中态此前只有边框色变化（labelChipSelected），读屏无从分辨：
                      多选标签必须用 aria-pressed 暴露逐个状态。 */}
                  <button
                    type="button"
                    className={labelChipMain}
                    aria-pressed={selected}
                    title={selected ? '点击从本卡片移除该标签' : '点击添加到本卡片'}
                    onClick={() => toggleLabel(l.id)}
                  >
                    <span className={labelDot} style={{ background: l.color }} />
                    {l.name}
                  </button>
                  {/* 「×」只用于撤销本次新增、尚未保存的标签。已持久化标签不渲染
                      它：那个 × 过去会把标签从整块看板所有卡片上删掉（连同标签
                      定义），而这里看起来只是在编辑一张卡片。 */}
                  {!persistedLabelIds.has(l.id) && (
                    <button
                      type="button"
                      className={labelChipDel}
                      onClick={() => removeLabel(l.id)}
                      aria-label={`移除新标签 ${l.name}（尚未保存）`}
                      title="移除这个刚添加、尚未保存的标签"
                    >
                      ×
                    </button>
                  )}
                </span>
              )
            })}
          </div>
        ) : (
          <span className={labelHint}>暂无标签，可在下方创建</span>
        )}
        <div className={labelCreateRow}>
          <SyncedInput
            type="color"
            className={colorSwatch}
            value={newLabelColor}
            onChange={(v) => setNewLabelColor(v)}
            aria-label="标签颜色"
          />
          <SyncedInput
            className={labelNameInput}
            placeholder="新标签名…"
            aria-label="新标签名"
            value={newLabelName}
            onChange={(v) => setNewLabelName(v)}
            onKeyDown={(e) => {
              // IME 组合中不拦截：回车确认候选词由输入法处理——不判定会把未确认的
              // 候选当最终输入（标签被提前添加）。
              if (isImeComposing(e)) return
              if (e.key === 'Enter') addLabel()
            }}
          />
          <button type="button" className={labelAddBtn} onClick={addLabel}>
            + 添加
          </button>
        </div>
      </div>

      {(saveMutation.isError || deleteMutation.isError) && (
        <div role="alert" style={{ color: 'var(--haze-color-danger)', fontSize: 12 }}>
          操作失败：
          {(saveMutation.error as Error)?.message ?? (deleteMutation.error as Error)?.message}
        </div>
      )}
    </Dialog>
  )
}
