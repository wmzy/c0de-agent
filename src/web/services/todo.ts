import { apiRequest } from './api.js'

export type TodoTaskStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned'

export type TodoTask = {
  content: string
  status: string
}

export type TodoPhase = {
  name: string
  tasks: TodoTask[]
}

export type TodoOp =
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

const todoAPI = {
  get: (sessionId: string) => apiRequest<TodoState>(`/api/todo/${sessionId}`),
  exec: (sessionId: string, op: TodoOp) =>
    apiRequest<TodoOpResult>(`/api/todo/${sessionId}`, {
      method: 'POST',
      body: JSON.stringify(op),
    }),
}

export { todoAPI }
