import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned'

type TodoTask = { content: string; status: string }
type TodoPhase = { name: string; tasks: TodoTask[] }
type TodoInput = {
  op?: string
  task?: string
  phase?: string
  items?: string[]
  list?: { phase: string; items: string[] }[]
}

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

const ROMAN_PAIRS: ReadonlyArray<readonly [number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
]

function roman(n: number): string {
  if (n <= 0) return ''
  let out = ''
  let rem = n
  for (const [value, sym] of ROMAN_PAIRS) {
    while (rem >= value) {
      out += sym
      rem -= value
    }
  }
  return out
}

const opLabel = css`
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, transparent);
  padding: 1px 6px;
  border-radius: 3px;
  margin-bottom: 6px;
`

const phaseHeader = css`
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 8px 0 2px;
  display: flex;
  align-items: center;
  gap: 4px;
`

const romanNum = css`
  color: var(--primary);
  font-weight: 700;
`

const taskRow = css`
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 2px 0;
  font-size: 13px;
  line-height: 1.4;
`

const taskIcon = css`
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-size: 12px;
  line-height: 1.4;
`

const taskContent = css`
  flex: 1;
  min-width: 0;
  word-break: break-word;
`

const completed = css`
  text-decoration: line-through;
  color: var(--text-secondary);
`

const abandoned = css`
  text-decoration: line-through;
  opacity: 0.6;
`

const board = css`
  margin-top: 4px;
`

const empty = css`
  color: var(--text-secondary);
  font-size: 13px;
  font-style: italic;
`

/** Render the todo board (phases with tasks). */
function Board({ phases }: { phases: TodoPhase[] }) {
  if (phases.length === 0) {
    return <div className={empty}>Todo list is empty.</div>
  }
  return (
    <div className={board}>
      {phases.map((phase) => {
        const doneCount = phase.tasks.filter(
          (t) => t.status === 'completed' || t.status === 'abandoned',
        ).length
        return (
          <div key={phase.name}>
            <div className={phaseHeader}>
              <span className={romanNum}>{roman(phases.indexOf(phase) + 1)}.</span>
              <span>{phase.name}</span>
              <span style={{ fontWeight: 400, opacity: 0.6 }}>
                ({doneCount}/{phase.tasks.length})
              </span>
            </div>
            {phase.tasks.map((task) => {
              const status = (
                ['pending', 'in_progress', 'completed', 'abandoned'].includes(task.status)
                  ? task.status
                  : 'pending'
              ) as TaskStatus
              return (
                <div key={task.content} className={taskRow}>
                  <span className={taskIcon} style={{ color: STATUS_COLORS[status] }}>
                    {TASK_ICONS[status]}
                  </span>
                  <span
                    className={`${taskContent} ${
                      status === 'completed' ? completed : status === 'abandoned' ? abandoned : ''
                    }`}
                  >
                    {task.content}
                  </span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

export function TodoToolView({
  input,
  output,
}: {
  input: unknown
  output?: ToolResult
  status: string
}) {
  const i = (input ?? {}) as TodoInput
  const op = i.op ?? 'view'

  // Extract phases from output metadata
  let phases: TodoPhase[] = []
  if (output?._tag === 'success') {
    const meta = output.metadata as { phases?: TodoPhase[] } | undefined
    if (meta?.phases && Array.isArray(meta.phases)) {
      phases = meta.phases
    }
  }

  return (
    <div>
      <span className={opLabel}>{op}</span>
      <Board phases={phases} />
    </div>
  )
}
