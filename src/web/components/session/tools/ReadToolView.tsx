import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { FileCodeBlock } from './FileCodeBlock.js'

const title = css`
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 2px;
`

const name = css`
  color: var(--text);
  font-weight: 500;
`

const err = css`
  font-size: 13px;
  color: var(--diff-del-text);
  background: var(--diff-del-bg);
  padding: 6px 8px;
  border-radius: 4px;
`

type ReadInput = { path: string; offset?: number; limit?: number }

export function ReadToolView({
  input,
  output,
  status,
}: {
  input: ReadInput
  output?: ToolResult
  status: string
}) {
  const path = input?.path ?? ''
  if (status === 'error' && output?._tag === 'error') {
    return (
      <div>
        <div className={title} data-testid="tool-title">
          <span className={name}>read</span> · {path}
        </div>
        <div className={err} data-testid="tool-error">
          {output.error}
        </div>
      </div>
    )
  }
  const content = output?._tag === 'success' || output?._tag === 'truncated' ? output.output : ''
  return (
    <div>
      <div className={title} data-testid="tool-title">
        <span className={name}>read</span>
      </div>
      <div className={title} data-testid="file-name">
        {path}
      </div>
      {content && <FileCodeBlock path={path} content={content} />}
    </div>
  )
}
