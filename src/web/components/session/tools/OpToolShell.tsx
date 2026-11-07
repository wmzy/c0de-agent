import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import type { ReactNode } from 'react'
import { ToolError } from '@/components/session/tools/toolError.js'
import { ToolTruncated } from '@/components/session/tools/toolTruncated.js'
import { str } from '@/components/session/utils/shapes.js'

/** op 徽标（todo/kanban 的操作名）：主色小标签，置于工具体首行。 */
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

/** op 型工具共享的空态/占位样式（「待办为空」「看板为空」与执行中说明同形）。 */
export const empty = css`
  color: var(--haze-color-text-secondary);
  font-size: 13px;
  font-style: italic;
`

/**
 * op 型工具（todo / kanban）的结果外壳：解析 op 徽标并统一三个短路分支，正常分支
 * 交给 children（渲染在徽标之后）。三个分支的共同口径：失败、截断、「结果还没
 * 回来」都必须先于任何内容渲染，绝不把「读不出来 / 没随结果返回 / 还没拿到」
 * 讲成一个关于内容的结论（如 "Todo list is empty." / 一行 op 名）。
 */
export function OpToolShell({
  tool,
  input,
  output,
  status,
  opPrefix = '',
  runningText,
  children,
}: {
  /** 工具名：决定执行中占位的 testid（`${tool}-running`），与 ToolInlineError 一致。 */
  tool: string
  input: unknown
  output?: ToolResult
  status: string
  /** op 徽标前缀（kanban 用 `kanban/`，todo 无前缀）。 */
  opPrefix?: string
  /** 「结果还没回来」时的占位文案（折叠头已显示「执行中」，正文给同一句话）。 */
  runningText: string
  /** 正常分支内容（op 徽标之后）：ToolInlineError、操作明细与看板/待办本体。 */
  children: (op: string) => ReactNode
}) {
  const i = (input ?? {}) as { op?: unknown }
  // op 直接当 React child 渲染：`{op:{kind:'add'}}` 这类形状会在渲染期抛
  // 「Objects are not valid as a React child」→ 整个应用壳被 ErrorBoundary 换掉
  // （input 与 metadata 一样是原样落库的未受信 JSON）。
  const op = str(i.op) ?? 'view'
  const label = `${opPrefix}${op}`

  // 失败优先于「空」：此前 _tag==='error' 会一路落到空渲染——todo 的工具失败被
  // 显示成 "Todo list is empty."、kanban move 失败整块塌成一行 op 名（metadata 里
  // 没有 board），用户看到的是一个与真实原因无关的结论。
  if (output?._tag === 'error' || status === 'error') {
    return (
      <div>
        <span className={opLabel}>{label}</span>
        <ToolError output={output} status={status} />
      </div>
    )
  }

  // 「输出被截断」不是「空」：超上限的结果以 _tag:'truncated' 返回且没有 metadata
  // （executor 只在 success 分支返回 metadata，见 src/tools/executor.ts），内容只
  // 能为空——此前被渲染成空态或一行 op 名，用户以为任务/卡片被删了。
  if (output?._tag === 'truncated') {
    return (
      <div>
        <span className={opLabel}>{label}</span>
        <ToolTruncated output={output} />
      </div>
    )
  }

  // 「结果还没回来」不是「空」：running 态（tool_result 尚未到达）此前一路落到空
  // 渲染——折叠头是「⏳ 执行中」，展开正文却写着空态或什么都不画，用户据此认定
  // 内容被清空而重新规划、重新下发任务，结果回来后又被真实内容替换回。没有结果
  // 就说还在执行。
  if (output === undefined) {
    return (
      <div>
        <span className={opLabel}>{label}</span>
        <div className={empty} data-testid={`${tool}-running`}>
          {runningText}
        </div>
      </div>
    )
  }

  return (
    <div>
      <span className={opLabel}>{label}</span>
      {children(op)}
    </div>
  )
}
