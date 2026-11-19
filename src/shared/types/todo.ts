/**
 * Todo shared types — todo 工具（tools/builtin/todo.ts）、REST 路由
 * （server/routes/todo.ts）、agent 状态（AgentState.todoPhases / todo_update 事件）
 * 与 web 服务（web/services/todo.ts）四方共用的单一形状。此前 web 侧手抄副本把
 * TodoTask.status 放宽为 string（渲染端 TASK_ICONS[status] 可能 undefined），
 * 收敛后本文件即正本。
 */

/** 任务状态（生命周期：pending → in_progress → completed；drop → abandoned）。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned'

export type TodoTask = {
  content: string
  status: TodoStatus
}

export type TodoPhase = {
  name: string
  tasks: TodoTask[]
}

/** A single todo operation entry (the tool's input params). */
export type TodoInput =
  | { op: 'init'; list?: { phase: string; items: string[] }[]; phase?: string; items?: string[] }
  | { op: 'start'; task: string }
  | { op: 'done'; task?: string; phase?: string }
  | { op: 'drop'; task?: string; phase?: string }
  | { op: 'rm'; task?: string; phase?: string }
  | { op: 'append'; phase: string; items: string[] }
  | { op: 'view' }

export type TodoState = {
  phases: TodoPhase[]
}

export type TodoOpResult = {
  phases: TodoPhase[]
  output: string
}

/** unknown → TodoStatus 运行时守卫：渲染端（toolShape）读取原样落库的
 *  metadata JSON 时用把畸形 status 归一为 'pending'，而非放行任意字符串
 *  导致 TASK_ICONS[status] 渲染 undefined。 */
export function isTodoStatus(v: unknown): v is TodoStatus {
  return v === 'pending' || v === 'in_progress' || v === 'completed' || v === 'abandoned'
}
