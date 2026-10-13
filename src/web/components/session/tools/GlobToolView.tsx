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

type GlobInput = { pattern: string; path?: string }

export function GlobToolView({
  output,
  status,
}: {
  input: GlobInput
  output?: ToolResult
  status: string
}) {
  // useOverflow 必须无条件调用（hooks 数量跨渲染恒定），短路判断放在其后。
  const { ref, overflowing, expanded, toggle } = useOverflow(200)
  // 失败必须走 ToolError：此前失败原因被塞进与匹配结果同形的中性灰 <pre>，
  // 且 error 为空串时整块渲染成空白（与 Read/Write/Edit 同一口径）。
  const errorText = toolErrorText(output, status)
  if (errorText !== null) return <ToolError output={output} status={status} />
  const text = output?._tag === 'success' || output?._tag === 'truncated' ? output.output : ''
  const showToggle = overflowing && !expanded
  return (
    <div>
      <MatchSummary output={output} noun="文件" />
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
