import { css } from '@linaria/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { kanbanAPI } from '../services/kanban.js'
import { type TodoOp, type TodoOpResult, type TodoPhase, todoAPI } from '../services/todo.js'
import { inputStyle } from '../styles/tokens.js'

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

const wrapper = css`
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
  flex-shrink: 0;
`

const summaryBar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 12px;
  font: inherit;
  font-size: 12px;
  text-align: left;
  color: var(--text-secondary);
  background: none;
  border: none;
  cursor: pointer;
  user-select: none;

  &:hover {
    background: var(--bg-hover, color-mix(in srgb, var(--bg) 95%, var(--text) 5%));
  }
`

const summaryIcon = css`
  font-size: 13px;
  flex-shrink: 0;
`

const summaryProgress = css`
  font-weight: 600;
  color: var(--text);
  flex-shrink: 0;
`

const summaryDivider = css`
  opacity: 0.3;
  flex-shrink: 0;
`

const summaryCurrent = css`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const summaryCurrentTask = css`
  color: var(--text);
`

const expandIcon = css`
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-secondary);
`

const body = css`
  max-height: 240px;
  overflow-y: auto;
  padding: 2px 0 6px;
`

const phaseGroup = css`
  margin-bottom: 2px;
`

const phaseHeader = css`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px 1px;
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
  padding: 2px 12px;
  font-size: 13px;
  line-height: 1.4;

  &:hover {
    background: var(--bg-hover, color-mix(in srgb, var(--bg) 95%, var(--text) 5%));
  }
`

const taskToggle = css`
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 0;
  font: inherit;
  text-align: left;
  color: inherit;
  background: none;
  border: none;
  cursor: pointer;
`

const taskIcon = css`
  flex-shrink: 0;
  width: 16px;
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

const addForm = css`
  display: flex;
  gap: 4px;
  padding: 4px 12px 6px;
`

const input = css`
  flex: 1;
  min-width: 0;
  padding: 3px 8px;
  font: inherit;
  font-size: 13px;
  outline: none;

  &:focus {
    border-color: var(--primary);
  }
`

const addBtn = css`
  padding: 3px 10px;
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
  padding: 2px 12px;
`

// ── Helpers ───────────────────────────────────────────────

function activeTaskInfo(phases: TodoPhase[]) {
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.status === 'in_progress') return { phase: phase.name, content: task.content }
    }
  }
  return null
}

// ── Component ─────────────────────────────────────────────

export function TodoPanel({ sessionId, projectId }: { sessionId: string; projectId?: string }) {
  const queryClient = useQueryClient()
  const todoKey = ['todo', sessionId]
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('c0de-agent:todoCollapsed') === '1',
  )
  const [showAdd, setShowAdd] = useState(false)
  const [newTask, setNewTask] = useState('')
  const [newPhase, setNewPhase] = useState('')
  const [error, setError] = useState('')
  const [exportResult, setExportResult] = useState<string | null>(null)

  const { data } = useQuery({
    queryKey: todoKey,
    queryFn: () => todoAPI.get(sessionId),
  })

  const phases: TodoPhase[] = data?.phases ?? []

  // P2-14：todo 与看板打通——把未完成任务导出为项目看板卡片（todo 列）。
  const exportMutation = useMutation({
    mutationFn: async ({ pid, todos }: { pid: string; todos: string[] }) => {
      let count = 0
      for (const title of todos) {
        await kanbanAPI.addCard(pid, { title, columnId: 'todo' })
        count += 1
      }
      return count
    },
    onSuccess: (count) => {
      setExportResult(`已导出 ${count} 个任务到看板`)
      setError('')
      setTimeout(() => setExportResult(null), 4000)
    },
    onError: (e: Error) => {
      setExportResult(null)
      setError(`导出到看板失败：${e.message}`)
    },
  })

  const handleExportToKanban = () => {
    if (!projectId) return
    const todos = phases
      .flatMap((p) => p.tasks)
      .filter((t) => t.status === 'pending' || t.status === 'in_progress')
      .map((t) => t.content)
    if (todos.length === 0) {
      setError('没有可导出的未完成任务')
      return
    }
    exportMutation.mutate({ pid: projectId, todos })
  }

  const execMutation = useMutation({
    mutationFn: ({ sessionId: sid, op }: { sessionId: string; op: TodoOp }) =>
      todoAPI.exec(sid, op),
    onSuccess: (result: TodoOpResult) => {
      queryClient.setQueryData(todoKey, { phases: result.phases })
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
    execMutation.mutate({
      sessionId,
      op: { op: 'append', phase: phaseName, items: [newTask.trim()] },
    })
    setNewTask('')
    setNewPhase('')
  }

  const toggleCollapse = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('c0de-agent:todoCollapsed', next ? '1' : '0')
  }

  const totalTasks = phases.reduce((sum, p) => sum + p.tasks.length, 0)
  const doneTasks = phases.reduce(
    (sum, p) =>
      sum + p.tasks.filter((t) => t.status === 'completed' || t.status === 'abandoned').length,
    0,
  )
  const current = activeTaskInfo(phases)

  return (
    <div className={wrapper} data-testid="todo-panel">
      <button
        type="button"
        className={summaryBar}
        onClick={totalTasks > 0 ? toggleCollapse : () => setShowAdd((v) => !v)}
      >
        <span className={summaryIcon}>📋</span>
        <span className={summaryProgress}>任务</span>
        {totalTasks > 0 && (
          <span className={phaseProgress}>
            {doneTasks}/{totalTasks}
          </span>
        )}
        {current && (
          <>
            <span className={summaryDivider}>·</span>
            <span className={summaryCurrent}>
              <span className={summaryCurrentTask}>{current.content}</span>
            </span>
          </>
        )}
        {totalTasks === 0 && !showAdd && <span className={summaryCurrent}>暂无任务，点击添加</span>}
        <span className={expandIcon}>{collapsed ? '▾' : '▴'}</span>
      </button>

      {!collapsed && totalTasks > 0 && (
        <div className={body}>
          {phases.map((phase) => {
            const done = phase.tasks.filter(
              (t) => t.status === 'completed' || t.status === 'abandoned',
            ).length
            return (
              <div key={phase.name} className={phaseGroup}>
                <div className={phaseHeader}>
                  <span>{phase.name}</span>
                  <span className={phaseProgress}>
                    {done}/{phase.tasks.length}
                  </span>
                </div>
                {phase.tasks.map((task) => {
                  const status = (
                    ['pending', 'in_progress', 'completed', 'abandoned'].includes(task.status)
                      ? task.status
                      : 'pending'
                  ) as TaskStatus
                  return (
                    <div key={task.content} className={`${taskItem} ${taskItemHover}`}>
                      <button
                        type="button"
                        className={taskToggle}
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
                      </button>
                      <div className={taskActions}>
                        {status !== 'abandoned' && (
                          <button type="button" title="放弃" onClick={() => dropTask(task.content)}>
                            ✕
                          </button>
                        )}
                        <button type="button" title="删除" onClick={() => removeTask(task.content)}>
                          🗑
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {showAdd && (
            <div className={addForm}>
              <input
                className={`${inputStyle} ${input}`}
                placeholder="任务描述…"
                value={newTask}
                onChange={(e) => setNewTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd()
                  if (e.key === 'Escape') setShowAdd(false)
                }}
              />
              <input
                className={`${inputStyle} ${input}`}
                placeholder="阶段（可选）"
                style={{ flex: '0 0 100px' }}
                value={newPhase}
                onChange={(e) => setNewPhase(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd()
                  if (e.key === 'Escape') setShowAdd(false)
                }}
              />
              <button
                type="button"
                className={`${inputStyle} ${addBtn} ${primaryBtn}`}
                onClick={handleAdd}
                disabled={!newTask.trim() || execMutation.isPending}
              >
                添加
              </button>
            </div>
          )}
        </div>
      )}

      {showAdd && (collapsed || totalTasks === 0) && (
        <div className={addForm}>
          <input
            className={`${inputStyle} ${input}`}
            placeholder="任务描述…"
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd()
              if (e.key === 'Escape') setShowAdd(false)
            }}
          />
          <input
            className={`${inputStyle} ${input}`}
            placeholder="阶段（可选）"
            style={{ flex: '0 0 100px' }}
            value={newPhase}
            onChange={(e) => setNewPhase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd()
              if (e.key === 'Escape') setShowAdd(false)
            }}
          />
          <button
            type="button"
            className={`${inputStyle} ${addBtn} ${primaryBtn}`}
            onClick={handleAdd}
            disabled={!newTask.trim() || execMutation.isPending}
          >
            添加
          </button>
        </div>
      )}

      {error && <div className={errorText}>{error}</div>}
      {exportResult && (
        <div
          className={errorText}
          style={{ color: 'var(--success)' }}
          data-testid="todo-export-result"
        >
          {exportResult}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 12px 8px' }}>
        <button
          type="button"
          className={`${inputStyle} ${addBtn}`}
          onClick={handleExportToKanban}
          disabled={!projectId || exportMutation.isPending}
          title={projectId ? '把未完成任务导出为项目看板卡片' : '无项目上下文，无法导出'}
          data-testid="todo-export-kanban"
        >
          导出到看板
        </button>
      </div>
    </div>
  )
}
