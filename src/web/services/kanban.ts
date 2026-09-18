import { del, get, patch, post } from '@/services/api.js'

export type KanbanPriority = 'high' | 'medium' | 'low'

export type KanbanColumnDef = {
  id: string
  name: string
}

export type KanbanLabelDef = {
  id: string
  name: string
  color: string
}

export type KanbanCard = {
  id: string
  boardId: string
  title: string
  description: string | null
  columnId: string
  priority: KanbanPriority
  position: number
  labels: string[]
  createdAt: string
  updatedAt: string
}

export type KanbanBoard = {
  id: string
  /** P2-5：回收站（软删除）看板 projectId 为 null；活动看板恒有值。 */
  projectId: string | null
  columns: KanbanColumnDef[]
  labels: KanbanLabelDef[]
  createdAt: string
  updatedAt: string
}

export type KanbanBoardWithCards = KanbanBoard & {
  cards: KanbanCard[]
}

/** P2-5：回收站看板条目。 */
export type DeletedKanbanBoard = {
  id: string
  projectName: string
  cardCount: number
  deletedAt: number
  /** 已到期进入物理清除宽限期的时间戳（ms）；null=尚未到期。 */
  purgePendingAt: number | null
  /** 删除时记录的原项目工作目录；null 或目录已不存在时无法「重建原项目」恢复。 */
  deletedProjectWorktree: string | null
}

const kanbanAPI = {
  /** 获取完整看板（列 + 标签 + 所有卡片）。 */
  get: (projectId: string) => get<KanbanBoardWithCards>(`/api/kanban/${projectId}`),
  /** 更新看板配置（列/标签）。 */
  updateBoard: (
    projectId: string,
    changes: { columns?: KanbanColumnDef[]; labels?: KanbanLabelDef[] },
  ) => patch<KanbanBoard>(`/api/kanban/${projectId}`, changes),
  /** 新建卡片。 */
  addCard: (
    projectId: string,
    input: {
      title: string
      description?: string | null
      columnId?: string
      priority?: KanbanPriority
      labels?: string[]
    },
  ) => post<KanbanCard>(`/api/kanban/${projectId}/cards`, input),
  /** 更新卡片字段或移动。 */
  updateCard: (
    projectId: string,
    cardId: string,
    changes: {
      title?: string
      description?: string | null
      priority?: KanbanPriority
      labels?: string[]
      columnId?: string
      position?: number
    },
  ) => patch<KanbanCard>(`/api/kanban/${projectId}/cards/${cardId}`, changes),
  /** 删除卡片。 */
  deleteCard: (projectId: string, cardId: string) =>
    del<{ ok: boolean }>(`/api/kanban/${projectId}/cards/${cardId}`),
  /** 导出整板（列+标签+卡片 JSON；项目删除会永久级联删除看板，导出是唯一备份）。 */
  exportBoard: (projectId: string) => get<unknown>(`/api/kanban/${projectId}/export`),
  /** P2-5：回收站看板列表（项目删除软删除的看板）。 */
  deletedBoards: () => get<{ boards: DeletedKanbanBoard[] }>('/api/kanban/deleted'),
  /** P1 修复：合并恢复回收站看板到指定项目——目标已有看板时缺失列与卡片
   *  并入现有看板（目标无板时等价普通恢复），不再 409 死胡同。 */
  restoreDeletedBoard: (boardId: string, projectId: string) =>
    post<{ ok: boolean; merged?: { mergedColumns: number; mergedCards: number } }>(
      `/api/kanban/deleted/${boardId}/restore`,
      { projectId, merge: true },
    ),
  /** P1 修复：重建原项目并合并恢复看板（目录仍存在时；原目录已有看板时同样合并）。 */
  restoreDeletedBoardToOriginal: (boardId: string) =>
    post<{
      ok: boolean
      merged?: { mergedColumns: number; mergedCards: number }
      recreatedProject?: { id: string; name: string | null }
    }>(`/api/kanban/deleted/${boardId}/restore`, { rebuild: true, merge: true }),
  /** P2-5：彻底删除回收站看板（不可恢复）。 */
  destroyDeletedBoard: (boardId: string) => del<{ ok: boolean }>(`/api/kanban/deleted/${boardId}`),
  /** 导入整板（原子替换列+标签+卡片）。 */
  importBoard: (projectId: string, data: unknown) =>
    post<{ ok: boolean; cardCount: number }>(`/api/kanban/${projectId}/import`, data),
}

export { kanbanAPI }
