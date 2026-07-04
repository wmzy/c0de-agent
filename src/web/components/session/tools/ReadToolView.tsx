import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { FileCodeBlock } from './FileCodeBlock.js'

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
  if (status === 'error' && output?._tag === 'error') {
    return (
      <div className={err} data-testid="tool-error">
        {output.error}
      </div>
    )
  }
  const path = input?.path ?? ''
  const content = output?._tag === 'success' || output?._tag === 'truncated' ? output.output : ''
  return <div>{content && <FileCodeBlock path={path} content={content} />}</div>
}
