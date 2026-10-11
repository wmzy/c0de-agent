import { css } from '@linaria/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from 'haze-ui'
import { useState } from 'react'
import { SyncedInput } from '@/components/SyncedControls.js'
import { kanbanAPI } from '@/services/kanban.js'
import { type TodoOp, type TodoOpResult, type TodoPhase, todoAPI } from '@/services/todo.js'
import { TOUCH } from '@/styles/breakpoints.js'
import { inputStyle } from '@/styles/tokens.js'
import { isImeComposing } from '@/utils/ime.js'
import { storageGet, storageSet } from '@/utils/storage.js'

// ── Status icons & colors ─────────────────────────────────

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned'

const TASK_ICONS: Record<TaskStatus, string> = {
  completed: '✓',
  in_progress: '→',
  abandoned: '✕',
  pending: '○',
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  completed: 'var(--haze-color-success)',
  in_progress: 'var(--haze-color-primary)',
  abandoned: 'var(--haze-color-text-secondary)',
  pending: 'var(--haze-color-text-secondary)',
}

// ── Styles ────────────────────────────────────────────────

const wrapper = css`
  border-top: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg-subtle);
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
  color: var(--haze-color-text-secondary);
  background: none;
  border: none;
  cursor: pointer;
  user-select: none;

  &:hover {
    background: var(--haze-color-bg-subtle, color-mix(in srgb, var(--haze-color-bg) 95%, var(--haze-color-text) 5%));
  }
`

const summaryIcon = css`
  font-size: 13px;
  flex-shrink: 0;
`

const summaryProgress = css`
  font-weight: 600;
  color: var(--haze-color-text);
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
  color: var(--haze-color-text);
`

const expandIcon = css`
  flex-shrink: 0;
  font-size: 10px;
  color: var(--haze-color-text-secondary);
`

const body = css`
  max-height: 240px;
  overflow-y: auto;
  padding: 2px 0 6px;
`

/**
 * 待办读失败态。与 ArchivePanel / KanbanView 同一套三段式（原因 + 重试），
 * 此前本面板只有 data 一个状态位：请求 500 时 data 为 undefined → phases 恒为 []
 * → 与「这个会话确实没有待办」落进同一分支（实测注入 500，面板稳定显示
 * 「暂无任务，点击添加」）。
 */
const errorState = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 12px;
`

const errorTitle = css`
  color: var(--haze-color-danger);
  font-size: 12px;
  font-weight: 600;
`

const errorDetail = css`
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  /* 后端 message 可能是长句，窄面板内必须断行 */
  overflow-wrap: anywhere;
`

const retryBtn = css`
  padding: 3px 12px;
  font-size: 12px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  cursor: pointer;

  &:hover {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
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
  color: var(--haze-color-text-secondary);
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
    background: var(--haze-color-bg-subtle, color-mix(in srgb, var(--haze-color-bg) 95%, var(--haze-color-text) 5%));
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
  color: var(--haze-color-text-secondary);
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
  /* 隐藏态不吞点击：opacity:0 的按钮照样接收 pointer 事件，
     触屏滑动阅读长任务时那一击会静默命中「放弃/删除」，任务被移除且无撤销。
     与 BranchTree 会话行删除按钮同一口径：显形时才允许命中。
     键盘不受影响——focus 与 pointer-events 无关，Tab 仍能进入。 */
  pointer-events: none;
  transition: opacity 0.15s;

  button {
    font-size: 11px;
    padding: 0 3px;
    border: none;
    background: transparent;
    color: var(--haze-color-text-secondary);
    cursor: pointer;

    &:hover {
      color: var(--haze-color-primary);
    }
  }
`

/*
 * 行内操作按钮的显隐。
 *
 * 此前只有 `:hover` 一条：键盘 Tab 进入「放弃 / 删除」时按钮仍是 opacity:0，
 * 屏幕上毫无变化——既看不到焦点落在哪（实测 containerOpacity=0、outline
 * none），也分不清按 Enter 会放弃还是删除这条任务；触屏没有 hover，按钮对
 * 手指等于不存在。按 BranchTree 的既有口径补齐三条触发源：hover、
 * focus-within（键盘）、TOUCH（触屏）。
 */
const taskItemHover = css`
  &:hover .${taskActions},
  &:focus-within .${taskActions} {
    opacity: 1;
    pointer-events: auto;
  }

  /* 触屏分支：TOUCH 必须写在顶层、括号内不能插 & —— 「TOUCH & .x {}」这种
     写法会被 postcss-nested 解析成 media 内先悬空一个 &，产出 @media not all，
     规则整条失效（实测编译结果如此）。与 BranchTree 同一写法。 */
  ${TOUCH} {
    & .${taskActions} {
      opacity: 1;
      pointer-events: auto;
    }
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
    border-color: var(--haze-color-primary);
  }
`

const addBtn = css`
  padding: 3px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

const primaryBtn = css`
  background: var(--haze-color-primary);
  color: var(--haze-color-bg);
  border-color: var(--haze-color-primary);

  &:hover {
    opacity: 0.9;
    color: var(--haze-color-bg);
  }
`

const errorText = css`
  color: var(--haze-color-danger);
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
  const [collapsed, setCollapsed] = useState(() => storageGet('c0de-agent:todoCollapsed') === '1')
  const [showAdd, setShowAdd] = useState(false)
  const [newTask, setNewTask] = useState('')
  const [newPhase, setNewPhase] = useState('')
  const [error, setError] = useState('')
  const [exportResult, setExportResult] = useState<string | null>(null)

  const {
    data,
    isLoading,
    isError,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: todoKey,
    queryFn: () => todoAPI.get(sessionId),
  })

  // 拉不到 ≠ 没有：data 缺失时 phases 恒为 []，读失败与「这个会话确实没有
  // 待办」此前落进同一分支（实测注入 500，面板稳定显示「暂无任务，点击添加」，
  // 「导出到看板」也回「没有可导出的未完成任务」）。
  const loadFailed = isError

  const phases: TodoPhase[] = data?.phases ?? []

  // P2-14：todo 与看板打通——把未完成任务导出为项目看板卡片。
  // 不指定 columnId：列 id 由用户维护（BoardConfigDialog 可删除空列、导入可整板
  // 替换列配置），硬编码 'todo' 在看板没有该列时被 store 的列校验拒绝（导出整体
  // 失败）；省略时 store 落到板的首列——与 kanban 工具「不要猜列 id」的契约一致。
  const exportMutation = useMutation({
    mutationFn: async ({ pid, todos }: { pid: string; todos: string[] }) => {
      let count = 0
      for (const title of todos) {
        await kanbanAPI.addCard(pid, { title })
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
    // 读失败时 phases 恒为 []，此前会落到下面「没有可导出的未完成任务」——
    // 把「拉不到」说成「没有任务可导出」，与面板的假空态是同一处误导。
    if (loadFailed) {
      setError('待办读取失败，无法导出。请先重试读取。')
      return
    }
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
    onSuccess: (result: TodoOpResult, vars: { sessionId: string; op: TodoOp }) => {
      queryClient.setQueryData(todoKey, { phases: result.phases })
      setError('')
      // 输入只在服务端真的受理后才清空：失败时用户刚打的任务文本必须留在
      // 输入框里（错误行已经说明原因，重试即可，不必凭记忆重打）。
      if (vars.op.op === 'append') {
        setNewTask('')
        setNewPhase('')
      }
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
    // 清空输入由 execMutation.onSuccess 统一负责（仅 append 操作），
    // 失败时文本留在框里，不让用户重打一遍。
    execMutation.mutate({
      sessionId,
      op: { op: 'append', phase: phaseName, items: [newTask.trim()] },
    })
  }

  const toggleCollapse = () => {
    const next = !collapsed
    setCollapsed(next)
    storageSet('c0de-agent:todoCollapsed', next ? '1' : '0')
  }

  const totalTasks = phases.reduce((sum, p) => sum + p.tasks.length, 0)
  const doneTasks = phases.reduce(
    (sum, p) =>
      sum + p.tasks.filter((t) => t.status === 'completed' || t.status === 'abandoned').length,
    0,
  )
  const current = activeTaskInfo(phases)

  // 摘要栏此前只看 totalTasks（来自 undefined?.phases ?? []，读失败恒为 0），
  // 于是失败时显示「暂无任务，点击添加」，用户认定 agent 的待办凭空消失。
  // 加载中/失败各说各的；失败时点摘要栏是重试，不是展开「新建」入口。
  const statusText = isLoading
    ? '加载中…'
    : loadFailed
      ? '读取失败，点此重试'
      : totalTasks === 0
        ? '暂无任务，点击添加'
        : null

  /** 打开新增行。清单非空时也必须可达：此前 setShowAdd(true) 只挂在摘要栏
   *  的 `totalTasks === 0` 分支上，agent 写入第一条任务后这个入口永久消失，
   *  用户再也打不开新增表单（面板只剩「导出到看板」）。 */
  const openAddForm = () => {
    setCollapsed(false)
    setShowAdd(true)
  }

  return (
    <div className={wrapper} data-testid="todo-panel">
      <button
        type="button"
        className={summaryBar}
        onClick={loadFailed ? () => void refetch() : totalTasks > 0 ? toggleCollapse : openAddForm}
      >
        <span className={summaryIcon}>📋</span>
        <span className={summaryProgress}>任务</span>
        <span
          className={summaryCurrent}
          title="会话内 agent 待办（todo 工具维护），独立于「看板」页的项目级任务看板；可用「导出到看板」把未完成任务复制到项目看板"
          data-testid="todo-scope-hint"
        >
          本会话待办
        </span>
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
        {statusText && !showAdd && (
          <span
            className={summaryCurrent}
            style={loadFailed ? { color: 'var(--haze-color-danger)' } : undefined}
          >
            {statusText}
          </span>
        )}
        <span className={expandIcon}>{loadFailed ? '↻' : collapsed ? '▾' : '▴'}</span>
      </button>

      {!collapsed && loadFailed && (
        <div className={errorState} role="alert" data-testid="todo-load-error">
          <span className={errorTitle}>待办读取失败</span>
          <span className={errorDetail}>
            {(queryError as { message?: string } | null)?.message ??
              (queryError instanceof Error ? queryError.message : null) ??
              '无法读取本会话的待办。'}
          </span>
          <button
            type="button"
            className={retryBtn}
            onClick={() => void refetch()}
            data-testid="todo-retry"
          >
            重试
          </button>
        </div>
      )}

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
                          /* aria-label 不能省：accname 先取元素内容（"✕"），title
                             只在无内容时兜底，读屏会把这个不可逆的操作播报成
                             「✕ 按钮」。任务文本进可访问名，用户才知道动的是哪一条。 */
                          <Button
                            title="放弃"
                            aria-label={`放弃任务：${task.content}`}
                            variant="outline"
                            onClick={() => dropTask(task.content)}
                          >
                            ✕
                          </Button>
                        )}
                        <Button
                          title="删除"
                          aria-label={`删除任务：${task.content}`}
                          variant="outline"
                          onClick={() => removeTask(task.content)}
                        >
                          🗑
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {showAdd && (
            <div className={addForm}>
              <SyncedInput
                className={`${inputStyle} ${input}`}
                placeholder="任务描述…"
                /* 两个输入框并排且都没有可见 label：显式 aria-label 而不是只靠
                 * placeholder（它只是视觉提示，HTML-AAM 兜底的名字来源很脆弱）。 */
                aria-label="任务描述"
                value={newTask}
                onChange={(v) => setNewTask(v)}
                onKeyDown={(e) => {
                  // IME 组合中不拦截：回车确认候选词/ESC 取消候选由输入法处理——
                  // 不判定会把未确认的候选当任务内容提交（并关闭输入行）。
                  if (isImeComposing(e)) return
                  if (e.key === 'Enter') handleAdd()
                  if (e.key === 'Escape') setShowAdd(false)
                }}
              />
              <SyncedInput
                className={`${inputStyle} ${input}`}
                placeholder="阶段（可选）"
                aria-label="阶段（可选）"
                style={{ flex: '0 0 100px' }}
                value={newPhase}
                onChange={(v) => setNewPhase(v)}
                onKeyDown={(e) => {
                  // IME 组合中不拦截：回车确认候选词/ESC 取消候选由输入法处理——
                  // 不判定会把未确认的候选当任务内容提交（并关闭输入行）。
                  if (isImeComposing(e)) return
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
          <SyncedInput
            className={`${inputStyle} ${input}`}
            placeholder="任务描述…"
            aria-label="任务描述"
            value={newTask}
            onChange={(v) => setNewTask(v)}
            onKeyDown={(e) => {
              // IME 组合中不拦截（同上）：候选未确认时不提交任务。
              if (isImeComposing(e)) return
              if (e.key === 'Enter') handleAdd()
              if (e.key === 'Escape') setShowAdd(false)
            }}
          />
          <SyncedInput
            className={`${inputStyle} ${input}`}
            placeholder="阶段（可选）"
            aria-label="阶段（可选）"
            style={{ flex: '0 0 100px' }}
            value={newPhase}
            onChange={(v) => setNewPhase(v)}
            onKeyDown={(e) => {
              // IME 组合中不拦截（同上）：候选未确认时不提交任务。
              if (isImeComposing(e)) return
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
          style={{ color: 'var(--haze-color-success)' }}
          data-testid="todo-export-result"
        >
          {exportResult}
        </div>
      )}
      <div
        style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '4px 12px 8px' }}
      >
        {/* 唯一的常驻新增入口。清单非空时摘要栏只切换折叠，新增行曾无路可达 */}
        <button
          type="button"
          className={`${inputStyle} ${addBtn}`}
          onClick={openAddForm}
          title="手动添加一条待办任务"
          data-testid="todo-add-task"
        >
          ＋ 添加任务
        </button>
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
