import { apiRequest } from './api.js'

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
}

const kanbanAPI = {
  /** 获取完整看板（列 + 标签 + 所有卡片）。 */
  get: (projectId: string) => apiRequest<KanbanBoardWithCards>(`/api/kanban/${projectId}`),
  /** 更新看板配置（列/标签）。 */
  updateBoard: (
    projectId: string,
    patch: { columns?: KanbanColumnDef[]; labels?: KanbanLabelDef[] },
  ) =>
    apiRequest<KanbanBoard>(`/api/kanban/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
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
  ) =>
    apiRequest<KanbanCard>(`/api/kanban/${projectId}/cards`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** 更新卡片字段或移动。 */
  updateCard: (
    projectId: string,
    cardId: string,
    patch: {
      title?: string
      description?: string | null
      priority?: KanbanPriority
      labels?: string[]
      columnId?: string
      position?: number
    },
  ) =>
    apiRequest<KanbanCard>(`/api/kanban/${projectId}/cards/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** 删除卡片。 */
  deleteCard: (projectId: string, cardId: string) =>
    apiRequest<{ ok: boolean }>(`/api/kanban/${projectId}/cards/${cardId}`, {
      method: 'DELETE',
    }),
  /** 导出整板（列+标签+卡片 JSON；项目删除会永久级联删除看板，导出是唯一备份）。 */
  exportBoard: (projectId: string) => apiRequest<unknown>(`/api/kanban/${projectId}/export`),
  /** P2-5：回收站看板列表（项目删除软删除的看板）。 */
  deletedBoards: () => apiRequest<{ boards: DeletedKanbanBoard[] }>('/api/kanban/deleted'),
  /** P2-5：恢复回收站看板到指定项目（目标已有看板 → 409）。 */
  restoreDeletedBoard: (boardId: string, projectId: string) =>
    apiRequest<{ ok: boolean }>(`/api/kanban/deleted/${boardId}/restore`, {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    }),
  /** P2-5：彻底删除回收站看板（不可恢复）。 */
  destroyDeletedBoard: (boardId: string) =>
    apiRequest<{ ok: boolean }>(`/api/kanban/deleted/${boardId}`, { method: 'DELETE' }),
  /** 导入整板（原子替换列+标签+卡片）。 */
  importBoard: (projectId: string, data: unknown) =>
    apiRequest<{ ok: boolean; cardCount: number }>(`/api/kanban/${projectId}/import`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
}

export { kanbanAPI }
