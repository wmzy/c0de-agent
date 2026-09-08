import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { css } from '@linaria/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ChangeEvent, useRef, useState } from 'react'
import { BoardConfigDialog } from '../components/kanban/BoardConfigDialog.js'
import { CardEditDialog } from '../components/kanban/CardEditDialog.js'
import { KanbanColumn } from '../components/kanban/KanbanColumn.js'
import { type KanbanCard, kanbanAPI } from '../services/kanban.js'

const view = css`
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
`

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
`

const headerTitle = css`
  font-size: 15px;
  font-weight: 600;
`

/** 看板定位说明：项目级 vs 会话内待办的边界（产品定位，P2）。 */
const headerHint = css`
  flex: 1;
  margin-left: 12px;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const configBtn = css`
  min-height: auto;
  min-width: auto;
  padding: 4px 12px;
  font-size: 12px;
`

const boardArea = css`
  display: flex;
  gap: 12px;
  padding: 12px;
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1;
  min-height: 0;
`

const loading = css`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  font-size: 14px;
`

/** 与后端 kanban store 的 POSITION_GAP 一致（拖拽中点插入的半距）。 */
const POSITION_GAP = 1000

const errorText = css`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--error);
  font-size: 14px;
`

type KanbanViewProps = {
  projectId: string
}

/** 看板主视图：加载 board、管理 DndContext 拖拽、卡片编辑/配置弹窗。 */
export function KanbanView({ projectId }: KanbanViewProps) {
  const qc = useQueryClient()
  const [editingCard, setEditingCard] = useState<KanbanCard | null>(null)
  const [showConfig, setShowConfig] = useState(false)
  const [ioError, setIoError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const {
    data: board,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['kanban', projectId],
    queryFn: () => kanbanAPI.get(projectId),
  })

  // 卡片移动（乐观更新通过 invalidate 实现）
  const moveMutation = useMutation({
    mutationFn: ({
      cardId,
      columnId,
      position,
    }: {
      cardId: string
      columnId: string
      position?: number
    }) => kanbanAPI.updateCard(projectId, cardId, { columnId, position }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kanban', projectId] }),
  })

  // 快速新建卡片
  const addMutation = useMutation({
    mutationFn: ({ title, columnId }: { title: string; columnId: string }) =>
      kanbanAPI.addCard(projectId, { title, columnId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kanban', projectId] }),
  })

  // ── DnD handlers ────────────────────────────────────────

  /**
   * dragover: 当卡片拖到不同列上方（还未释放）时，实时预览移动。
   * 这样即使最后 drop 到空白列区域也能正确落位。
   */
  const handleDragOver = (_e: DragOverEvent) => {
    // 仅在 dragEnd 时提交，这里不做乐观更新避免频繁 mutation
  }

  /**
   * dragEnd: 根据释放位置计算目标 columnId 和 position。
   * dnd-kit 的 over.id 可能是另一个卡片（插入其位置）或一个列（空白区）。
   * P2-7：落在卡片上时取「前一张卡片与目标卡片的中点」作为 position——
   * 此前直接复用 overCard.position 造成同列多卡同值、排序不稳定。
   */
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return

    if (!board) return
    const activeCard = board.cards.find((c) => c.id === active.id)
    if (!activeCard) return

    // over.id 可能是卡片 id 或列 id
    const overId = String(over.id)
    const overCard = board.cards.find((c) => c.id === overId)
    const targetColumnId = overCard ? overCard.columnId : overId

    // 计算插入位置：落在卡片上 → 中点插入（激活卡片原在目标卡片下方时插到其后，
    // 否则插到其前）；落在列空白 → 追加末尾。
    // 落点与当前位置等价（前驱就是自己）→ 无位移，跳过。
    let position: number | undefined
    if (overCard) {
      const columnCards = board.cards
        .filter((c) => c.columnId === overCard.columnId)
        .sort((a, b) => a.position - b.position)
      const overIdx = columnCards.findIndex((c) => c.id === overCard.id)
      const activeIdx = columnCards.findIndex((c) => c.id === activeCard.id)
      if (overIdx === -1) {
        position = overCard.position
      } else if (activeIdx === -1 || activeIdx < overIdx) {
        // 激活卡片不在该列或原在目标上方：插到目标之前
        const prev = columnCards[overIdx - 1]
        if (prev && prev.id === activeCard.id) return // 位置未变
        position = prev
          ? (prev.position + overCard.position) / 2
          : overCard.position - POSITION_GAP / 2
      } else {
        // 激活卡片原在目标下方：插到目标之后
        const next = columnCards[overIdx + 1]
        if (next && next.id === activeCard.id) return // 位置未变
        position = next
          ? (next.position + overCard.position) / 2
          : overCard.position + POSITION_GAP / 2
      }
    }

    moveMutation.mutate({ cardId: activeCard.id, columnId: targetColumnId, position })
  }

  /** 导出整板为 JSON 文件（项目删除会永久级联删除看板——导出是唯一备份途径）。 */
  const handleExport = async () => {
    setIoError(null)
    try {
      const data = await kanbanAPI.exportBoard(projectId)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `kanban-${projectId}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setIoError(err instanceof Error ? err.message : '导出失败')
    }
  }

  /** 导入整板：替换当前列+标签+卡片。fail-closed 确认（不可撤销）。 */
  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setIoError(null)
    try {
      const data = JSON.parse(await file.text()) as unknown
      const cards = (data as { cards?: unknown }).cards
      const cardCount = Array.isArray(cards) ? cards.length : 0
      if (
        !window.confirm(
          `导入将替换当前看板的列、标签与全部卡片（${cardCount} 张导入卡片），且不可撤销。确定继续？`,
        )
      ) {
        return
      }
      const result = await kanbanAPI.importBoard(projectId, data)
      await qc.invalidateQueries({ queryKey: ['kanban', projectId] })
      setIoError(null)
      // 静默成功即可：看板即时刷新可见
      void result
    } catch (err) {
      setIoError(err instanceof Error ? err.message : '导入失败')
    }
  }

  if (isLoading) {
    return (
      <div className={view}>
        <div className={loading}>加载看板…</div>
      </div>
    )
  }

  if (isError || !board) {
    return (
      <div className={view}>
        <div className={errorText}>看板加载失败</div>
      </div>
    )
  }

  return (
    <div className={view} data-testid="kanban-view">
      <div className={header}>
        <span className={headerTitle}>📋 看板</span>
        <span
          className={headerHint}
          title="项目级任务看板，与聊天页的 agent 待办（TodoPanel）相互独立：看板由你手动维护，也可让 agent 用 kanban 工具操作"
        >
          项目级任务看板 · 独立于会话内的 agent 待办
        </span>
        <button
          type="button"
          className={configBtn}
          onClick={() => setShowConfig(true)}
          data-testid="kanban-config-btn"
        >
          ⚙️ 设置
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => void handleImportFile(e)}
          data-testid="kanban-import-input"
        />
        <button
          type="button"
          className={configBtn}
          onClick={() => void handleExport()}
          data-testid="kanban-export-btn"
        >
          ⬇ 导出
        </button>
        <button
          type="button"
          className={configBtn}
          onClick={() => fileInputRef.current?.click()}
          data-testid="kanban-import-btn"
        >
          ⬆ 导入
        </button>
      </div>
      {ioError && (
        <div
          className={errorText}
          style={{ height: 'auto', padding: '4px 12px' }}
          data-testid="kanban-io-error"
        >
          {ioError}
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className={boardArea}>
          {board.columns.map((col) => {
            const colCards = board.cards
              .filter((c) => c.columnId === col.id)
              .sort((a, b) => a.position - b.position)
            return (
              <KanbanColumn
                key={col.id}
                column={col}
                cards={colCards}
                labels={board.labels}
                onCardClick={(c) => setEditingCard(c)}
                onQuickAdd={(title) => addMutation.mutate({ title, columnId: col.id })}
              />
            )
          })}
        </div>
      </DndContext>

      {editingCard && (
        <CardEditDialog
          projectId={projectId}
          cardId={editingCard.id}
          initialTitle={editingCard.title}
          initialDescription={editingCard.description}
          initialPriority={editingCard.priority}
          initialLabels={editingCard.labels}
          boardLabels={board.labels}
          onClose={() => setEditingCard(null)}
        />
      )}

      {showConfig && (
        <BoardConfigDialog
          projectId={projectId}
          columns={board.columns}
          labels={board.labels}
          cards={board.cards}
          onClose={() => setShowConfig(false)}
        />
      )}
    </div>
  )
}
