import type {
  TodoInput as TodoOp,
  TodoOpResult,
  TodoPhase,
  TodoState,
  TodoTask,
} from '@shared/types/todo.js'
import { get, post } from '@/services/api.js'

// 契约正本在 @shared/types/todo.ts（todo 工具 / REST 路由 / agent 状态 /
// web 服务四方共用）。此前本地手抄副本把 TodoTask.status 放宽为 string，
// 渲染端 TASK_ICONS[status] 可能 undefined；现已收紧回四值联合。
export type { TodoOp, TodoOpResult, TodoPhase, TodoState, TodoTask, TodoTaskStatus }

const todoAPI = {
  get: (sessionId: string) => get<TodoState>(`/api/todo/${sessionId}`),
  exec: (sessionId: string, op: TodoOp) => post<TodoOpResult>(`/api/todo/${sessionId}`, op),
}

export { todoAPI }

/** todo 状态查询键（TodoPanel 查询与乐观回写、useChat 失效统一走这里——
 *  此前跨 hooks/components 3 处手抄 ['todo', sessionId]）。 */
export function todoKey(sessionId: string) {
  return ['todo', sessionId] as const
}
