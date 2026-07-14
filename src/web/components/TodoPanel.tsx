import { css } from '@linaria/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { todoAPI, type TodoOp, type TodoOpResult, type TodoPhase } from '../services/todo.js'

// ── Status icons & colors ─────────────────────────────────

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned'

const TASK_ICONS: Record<TaskStatus, string> = {
  completed: '✓',
  in_progress: '→',
  abandoned: '✕',
  pending: '○',
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  completed: 'var(--success)',
  in_progress: 'var(--primary)',
  abandoned: 'var(--text-secondary)',
  pending: 'var(--text-secondary)',
}

// ── Styles ────────────────────────────────────────────────

const panel = css`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
`

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
`

const title = css`
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
`

const addBtn = css`
  font-size: 14px;
  line-height: 1;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;

  &:hover {
    color: var(--primary);
    border-color: var(--primary);
  }
`

const list = css`
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 4px 0;
`

const phaseGroup = css`
  margin-bottom: 4px;
`

const phaseHeader = css`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 2px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
`

const phaseProgress = css`
  font-weight: 400;
  opacity: 0.7;
  font-size: 10px;
`

const taskItem = css`
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 3px 10px;
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;

  &:hover {
    background: var(--bg-hover, var(--bg-secondary));
  }
`

const taskIcon = css`
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  text-align: center;
  font-size: 13px;
  line-height: 1.4;
  user-select: none;
`

const taskText = css`
  flex: 1;
  min-width: 0;
  word-break: break-word;
`

const taskDone = css`
  text-decoration: line-through;
  color: var(--text-secondary);
`

const taskAbandoned = css`
  text-decoration: line-through;
  opacity: 0.5;
`

const taskActions = css`
  flex-shrink: 0;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;

  button {
    font-size: 11px;
    padding: 0 3px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;

    &:hover {
      color: var(--primary);
    }
  }
`

const taskItemHover = css`
  &:hover .${taskActions} {
    opacity: 1;
  }
`

const emptyState = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 20px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
  gap: 8px;
`

const addForm = css`
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
`

const input = css`
  width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  outline: none;

  &:focus {
    border-color: var(--primary);
  }
`

const formRow = css`
  display: flex;
  gap: 4px;
`

const formBtn = css`
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    border-color: var(--primary);
    color: var(--primary);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

const primaryBtn = css`
  background: var(--primary);
  color: var(--bg);
  border-color: var(--primary);

  &:hover {
    opacity: 0.9;
    color: var(--bg);
  }
`

const errorText = css`
  color: var(--error);
  font-size: 12px;
  padding: 2px 0;
`

// ── Component ─────────────────────────────────────────────

export function TodoPanel({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient()
  const todoKey = ['todo', sessionId]
  const [showAdd, setShowAdd] = useState(false)
  const [newTask, setNewTask] = useState('')
  const [newPhase, setNewPhase] = useState('')
  const [error, setError] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: todoKey,
    queryFn: () => todoAPI.get(sessionId),
  })

  const phases: TodoPhase[] = data?.phases ?? []

  const execMutation = useMutation({
    mutationFn: ({ sessionId: sid, op }: { sessionId: string; op: TodoOp }) =>
      todoAPI.exec(sid, op),
    onSuccess: (result: TodoOpResult) => {
      queryClient.setQueryData(todoKey, { phases: result.phases })
      setError('')
    },
    onError: (e: Error) => setError(e.message),
  })

  const addMutation = useMutation({
    mutationFn: ({ sessionId: sid, op }: { sessionId: string; op: TodoOp }) =>
      todoAPI.exec(sid, op),
    onSuccess: (result: TodoOpResult) => {
      queryClient.setQueryData(todoKey, { phases: result.phases })
      setNewTask('')
      setError('')
    },
    onError: (e: Error) => setError(e.message),
  })

  const toggleTask = (taskContent: string, status: string) => {
    const op: TodoOp =
      status === 'completed' || status === 'abandoned'
        ? { op: 'start', task: taskContent }
        : { op: 'done', task: taskContent }
    execMutation.mutate({ sessionId, op })
  }

  const dropTask = (taskContent: string) => {
    execMutation.mutate({ sessionId, op: { op: 'drop', task: taskContent } })
  }

  const removeTask = (taskContent: string) => {
    execMutation.mutate({ sessionId, op: { op: 'rm', task: taskContent } })
  }

  const handleAdd = () => {
    if (!newTask.trim()) return
    const phaseName = newPhase.trim() || (phases[0]?.name ?? 'Tasks')
    addMutation.mutate({
      sessionId,
      op: { op: 'append', phase: phaseName, items: [newTask.trim()] },
    })
  }

  const totalTasks = phases.reduce((sum, p) => sum + p.tasks.length, 0)
  const doneTasks = phases.reduce(
    (sum, p) => sum + p.tasks.filter((t) => t.status === 'completed' || t.status === 'abandoned').length,
    0,
  )

  return (
    <div className={panel} data-testid="todo-panel">
      <div className={header}>
        <span className={title}>
          📋 任务 {totalTasks > 0 && <span className={phaseProgress}>({doneTasks}/{totalTasks})</span>}
        </span>
        <button type="button" className={addBtn} onClick={() => setShowAdd((v) => !v)} title="添加任务">
          {showAdd ? '−' : '+'}
        </button>
      </div>

      <div className={list}>
        {isLoading ? (
          <div className={emptyState}>加载中…</div>
        ) : phases.length === 0 || totalTasks === 0 ? (
          <div className={emptyState}>
            <span>暂无任务</span>
            <span style={{ fontSize: 12 }}>点击 + 添加任务，或让 AI 用 todo 工具创建</span>
          </div>
        ) : (
          phases.map((phase, pi) => {
            const done = phase.tasks.filter(
              (t) => t.status === 'completed' || t.status === 'abandoned',
            ).length
            return (
              <div key={`phase-${pi}`} className={phaseGroup}>
                <div className={phaseHeader}>
                  <span>{phase.name}</span>
                  <span className={phaseProgress}>{done}/{phase.tasks.length}</span>
                </div>
                {phase.tasks.map((task, ti) => {
                  const status = (
                    ['pending', 'in_progress', 'completed', 'abandoned'].includes(task.status)
                      ? task.status
                      : 'pending'
                  ) as TaskStatus
                  return (
                    <div
                      key={`task-${pi}-${ti}`}
                      className={`${taskItem} ${taskItemHover}`}
                      onClick={() => toggleTask(task.content, task.status)}
                    >
                      <span className={taskIcon} style={{ color: STATUS_COLORS[status] }}>
                        {TASK_ICONS[status]}
                      </span>
                      <span
                        className={`${taskText} ${
                          status === 'completed'
                            ? taskDone
                            : status === 'abandoned'
                              ? taskAbandoned
                              : ''
                        }`}
                      >
                        {task.content}
                      </span>
                      <div className={taskActions} onClick={(e) => e.stopPropagation()}>
                        {status !== 'abandoned' && (
                          <button
                            type="button"
                            title="放弃"
                            onClick={() => dropTask(task.content)}
                          >
                            ✕
                          </button>
                        )}
                        <button
                          type="button"
                          title="删除"
                          onClick={() => removeTask(task.content)}
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })
        )}
      </div>

      {error && <div className={errorText}>{error}</div>}

      {showAdd && (
        <div className={addForm}>
          <input
            className={input}
            placeholder="任务描述…"
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd()
              if (e.key === 'Escape') setShowAdd(false)
            }}
            autoFocus
          />
          <div className={formRow}>
            <input
              className={input}
              placeholder="阶段名（留空=当前/默认）"
              value={newPhase}
              onChange={(e) => setNewPhase(e.target.value)}
            />
            <button
              type="button"
              className={`${formBtn} ${primaryBtn}`}
              onClick={handleAdd}
              disabled={!newTask.trim() || addMutation.isPending}
            >
              添加
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
