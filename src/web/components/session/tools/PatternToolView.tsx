import type { ToolResult } from '@shared/types/tool.js'
import { CollapsiblePre } from '@/components/session/tools/CollapsiblePre.js'
import { MatchSummary } from '@/components/session/tools/matchSummary.js'
import { ToolError, toolErrorText } from '@/components/session/tools/toolError.js'

type PatternToolInput = { pattern: string; path?: string }

/**
 * 模式匹配类工具（grep / glob）的结果视图：一句匹配旁白 + 可折叠的输出块。
 * 两个工具的渲染此前各持一份 72 行实现，仅 `noun`（「文件」/「匹配」）不同，
 * 收敛为单组件按 noun 参数化。
 */
export function PatternToolView({
  output,
  status,
  noun,
}: {
  input: PatternToolInput
  output?: ToolResult
  status: string
  /** 匹配旁白的宾语（glob=文件，grep=匹配），见 MatchSummary。 */
  noun: string
}) {
  // 失败必须走 ToolError：此前失败原因被塞进与命中结果一模一样的中性灰 <pre>，
  // 「失败」和「命中」视觉上完全同形；error 为空白串时整块渲染成空白
  // （与 Read/Write/Edit 同一口径）。
  const errorText = toolErrorText(output, status)
  if (errorText !== null) return <ToolError output={output} status={status} />
  const text = output?._tag === 'success' || output?._tag === 'truncated' ? output.output : ''
  return (
    <div>
      <MatchSummary output={output} noun={noun} />
      {text && <CollapsiblePre testId="tool-output">{text}</CollapsiblePre>}
    </div>
  )
}
