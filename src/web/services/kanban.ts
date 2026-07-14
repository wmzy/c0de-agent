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
  projectId: string
  columns: KanbanColumnDef[]
  labels: KanbanLabelDef[]
  createdAt: string
  updatedAt: string
}

export type KanbanBoardWithCards = KanbanBoard & {
  cards: KanbanCard[]
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
}

export { kanbanAPI }
