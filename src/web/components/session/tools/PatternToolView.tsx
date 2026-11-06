import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { useOverflow } from '@/components/session/hooks/useOverflow.js'
import { MatchSummary } from '@/components/session/tools/matchSummary.js'
import { ToolError, toolErrorText } from '@/components/session/tools/toolError.js'

const pre = css`
  margin: 0;
  padding: 8px;
  background: var(--haze-color-bg-muted);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 400px;
`

const collapsed = css`
  max-height: 200px;
  /* 只限高不裁剪，超长输出会照样画到盒子之外：折叠态看起来没折叠，
     「展开」按钮被压在输出文字上，虚拟化行高（量的是这个盒子）也会
     小于实际绘制高度、让输出盖住下一条消息。同 FallbackToolView。 */
  overflow: hidden;
`

const btn = css`
  font-size: 12px;
  color: var(--haze-color-primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

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
  // useOverflow 必须无条件调用（hooks 数量跨渲染恒定），短路判断放在其后。
  const { ref, overflowing, expanded, toggle } = useOverflow(200)
  // 失败必须走 ToolError：此前失败原因被塞进与命中结果一模一样的中性灰 <pre>，
  // 「失败」和「命中」视觉上完全同形；error 为空白串时整块渲染成空白
  // （与 Read/Write/Edit 同一口径）。
  const errorText = toolErrorText(output, status)
  if (errorText !== null) return <ToolError output={output} status={status} />
  const text = output?._tag === 'success' || output?._tag === 'truncated' ? output.output : ''
  const showToggle = overflowing && !expanded
  return (
    <div>
      <MatchSummary output={output} noun={noun} />
      {text && (
        <div>
          <div ref={ref} className={showToggle ? collapsed : ''}>
            <pre data-testid="tool-output" className={pre}>
              {text}
            </pre>
          </div>
          {overflowing && (
            <button type="button" className={btn} onClick={toggle}>
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
