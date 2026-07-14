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
import { useState } from 'react'
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

    // 计算插入位置：落在卡片上 → 该卡片位置；落在列空白 → 追加末尾
    let position: number | undefined
    if (overCard) {
      position = overCard.position
    }

    moveMutation.mutate({ cardId: activeCard.id, columnId: targetColumnId, position })
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
        <button
          type="button"
          className={configBtn}
          onClick={() => setShowConfig(true)}
          data-testid="kanban-config-btn"
        >
          ⚙️ 设置
        </button>
      </div>

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
          onClose={() => setShowConfig(false)}
        />
      )}
    </div>
  )
}
