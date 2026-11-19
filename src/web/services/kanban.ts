// 看板契约类型（KanbanPriority/列/标签/卡片/看板/回收站条目/合并计数）的正典在
// shared/types/kanban.ts，由 store、REST 路由与 kanban 工具三方共用；此处
// re-export 供 web 侧消费。
import type {
  DeletedKanbanBoard,
  KanbanBoard,
  KanbanBoardWithCards,
  KanbanCard,
  KanbanColumnDef,
  KanbanLabelDef,
  KanbanPriority,
  MergedBoardCounts,
} from '@shared/types/kanban.js'
import { del, get, patch, post } from '@/services/api.js'

export type {
  DeletedKanbanBoard,
  KanbanBoard,
  KanbanBoardWithCards,
  KanbanCard,
  KanbanColumnDef,
  KanbanLabelDef,
  KanbanPriority,
  MergedBoardCounts,
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
  /** P1 修复：合并恢复回收站看板到指定项目——目标已有看板时缺失列、标签与卡片
   *  并入现有看板（目标无板时等价普通恢复），不再 409 死胡同。 */
  restoreDeletedBoard: (boardId: string, projectId: string) =>
    post<{ ok: boolean; merged?: MergedBoardCounts }>(`/api/kanban/deleted/${boardId}/restore`, {
      projectId,
      merge: true,
    }),
  /** P1 修复：重建原项目并合并恢复看板（目录仍存在时；原目录已有看板时同样合并）。 */
  restoreDeletedBoardToOriginal: (boardId: string) =>
    post<{
      ok: boolean
      merged?: MergedBoardCounts
      recreatedProject?: { id: string; name: string | null }
    }>(`/api/kanban/deleted/${boardId}/restore`, { rebuild: true, merge: true }),
  /** P2-5：彻底删除回收站看板（不可恢复）。 */
  destroyDeletedBoard: (boardId: string) => del<{ ok: boolean }>(`/api/kanban/deleted/${boardId}`),
  /** 导入整板（原子替换列+标签+卡片）。 */
  importBoard: (projectId: string, data: unknown) =>
    post<{ ok: boolean; cardCount: number }>(`/api/kanban/${projectId}/import`, data),
}

export { kanbanAPI }

/** 项目看板查询键（KanbanView 查询与乐观更新、看板/卡片弹窗失效统一走这里——
 *  此后跨 3 文件 10+ 处手抄 ['kanban', projectId]）。 */
export function kanbanKey(projectId: string) {
  return ['kanban', projectId] as const
}

/** 已删除看板列表查询键（回收站）。 */
export function deletedKanbanKey() {
  return ['kanban', 'deleted'] as const
}

/** 看板根前缀键（恢复到原项目等客户端不知道目标项目 id 的场景：前缀失效
 *  命中所有项目键 + deleted 键）。 */
export function kanbanRootKey() {
  return ['kanban'] as const
}
