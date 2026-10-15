import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { ToolError, ToolInlineError } from '@/components/session/tools/toolError.js'
import { ShapeNotice, str, wellFormedPhases } from '@/components/session/tools/toolShape.js'
import { ToolTruncated } from '@/components/session/tools/toolTruncated.js'

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
  completed: 'var(--haze-color-success)',
  in_progress: 'var(--haze-color-primary)',
  abandoned: 'var(--haze-color-text-secondary)',
  pending: 'var(--haze-color-text-secondary)',
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
  color: var(--haze-color-primary);
  background: color-mix(in srgb, var(--haze-color-primary) 10%, transparent);
  padding: 1px 6px;
  border-radius: 3px;
  margin-bottom: 6px;
`

const phaseHeader = css`
  font-size: 12px;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 8px 0 2px;
  display: flex;
  align-items: center;
  gap: 4px;
`

const romanNum = css`
  color: var(--haze-color-primary);
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
  color: var(--haze-color-text-secondary);
`

const abandoned = css`
  text-decoration: line-through;
  opacity: 0.6;
`

const board = css`
  margin-top: 4px;
`

const empty = css`
  color: var(--haze-color-text-secondary);
  font-size: 13px;
  font-style: italic;
`

/** Render the todo board (phases with tasks).
 *
 *  unreadable：形状有丢弃且一条都没剩下——此时「待办为空」是谎报（真实情况是
 *  读不出来），空态让位给 ShapeNotice。 */
function Board({ phases, unreadable = false }: { phases: TodoPhase[]; unreadable?: boolean }) {
  if (phases.length === 0) {
    return unreadable ? null : <div className={empty}>Todo list is empty.</div>
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
  status,
}: {
  input: unknown
  output?: ToolResult
  status: string
}) {
  const i = (input ?? {}) as TodoInput
  // op 直接当 React child 渲染：`{op:{kind:'add'}}` 这类形状会在渲染期抛
  // 「Objects are not valid as a React child」→ 整个应用壳被 ErrorBoundary 换掉
  // （input 与 metadata 一样是原样落库的未受信 JSON）。
  const op = str(i.op) ?? 'view'

  // 失败优先于「空」：此前 _tag==='error' 会一路落到 Board 的空渲染，
  // 工具失败被显示成 "Todo list is empty."，用户看到的是一个与真实原因无关的结论。
  if (output?._tag === 'error' || status === 'error') {
    return (
      <div>
        <span className={opLabel}>{op}</span>
        <ToolError output={output} status={status} />
      </div>
    )
  }

  // 「输出被截断」不是「待办为空」：超上限的结果以 _tag:'truncated' 返回且没有
  // metadata，phases 只能为空，Board 会把「内容没随结果返回」说成
  // "Todo list is empty."——用户以为任务被删了（executor 只在 success 分支返回
  // metadata，见 src/tools/executor.ts）。
  if (output?._tag === 'truncated') {
    return (
      <div>
        <span className={opLabel}>{op}</span>
        <ToolTruncated output={output} />
      </div>
    )
  }

  // Extract phases from output metadata
  //
  // metadata 是原样落库的未受信 JSON（持久层只过滤 _parseError/_raw，导入层只校验
  // 分片外形、不递归 metadata）：`{name:1, tasks:'garbage'}` 之类畸形条目原样入库，
  // 此前直接 `meta.phases as TodoPhase[]` 后渲染，在 `phase.tasks.filter` 处抛错 →
  // 整个应用（含侧栏/顶栏）被 ErrorBoundary 换成「页面渲染出错」，该会话再也无法
  // 展开这条工具块。渲染前收敛（与 src/tools/builtin/todo.ts 的 sanitize 同口径）：
  // 畸形条目丢弃并计数，丢掉的必须说出来，绝不把「读不出来」说成「待办为空」。
  let phases: TodoPhase[] = []
  let dropped = 0
  let malformed = false
  if (output?._tag === 'success') {
    const meta = output.metadata as { phases?: unknown } | undefined
    const parsed = wellFormedPhases(meta?.phases)
    phases = parsed.value
    dropped = parsed.dropped
    malformed = parsed.malformed
  }

  return (
    <div>
      <span className={opLabel}>{op}</span>
      <ToolInlineError output={output} tool="todo" />
      <Board phases={phases} unreadable={dropped > 0 || malformed} />
      {(dropped > 0 || malformed) && <ShapeNotice dropped={dropped} />}
    </div>
  )
}
