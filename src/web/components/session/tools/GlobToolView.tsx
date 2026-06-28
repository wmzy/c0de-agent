import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { useOverflow } from '../hooks/useOverflow.js'

const title = css`
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 2px;
`

const pre = css`
  margin: 0;
  padding: 8px;
  background: var(--code-bg);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 400px;
`

const collapsed = css`
  max-height: 200px;
`

const btn = css`
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

type GlobInput = { pattern: string; path?: string }

export function GlobToolView({
  input,
  output,
}: {
  input: GlobInput
  output?: ToolResult
  status: string
}) {
  const pattern = input?.pattern ?? ''
  const text =
    output?._tag === 'success' || output?._tag === 'truncated'
      ? output.output
      : output?._tag === 'error'
        ? output.error
        : ''
  const { ref, overflowing, expanded, toggle } = useOverflow(200)
  const showToggle = overflowing && !expanded
  return (
    <div>
      <div className={title} data-testid="tool-title">
        Glob · {pattern}
      </div>
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
