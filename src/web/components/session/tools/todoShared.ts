// 待办任务的状态令牌（图标 + 颜色）：TodoPanel（会话待办面板）与 TodoToolView
// （todo 工具消息视图）曾各持一份逐字副本，收敛于此。TaskStatus 复用服务端
// 契约里已存在的 TodoTaskStatus，不再第二种拼法。
import type { TodoTaskStatus } from '@/services/todo.js'

export type TaskStatus = TodoTaskStatus

export const TASK_ICONS: Record<TaskStatus, string> = {
  completed: '✓',
  in_progress: '→',
  abandoned: '✕',
  pending: '○',
}

export const STATUS_COLORS: Record<TaskStatus, string> = {
  completed: 'var(--haze-color-success)',
  in_progress: 'var(--haze-color-primary)',
  abandoned: 'var(--haze-color-text-secondary)',
  pending: 'var(--haze-color-text-secondary)',
}
