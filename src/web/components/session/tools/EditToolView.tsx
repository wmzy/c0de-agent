import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { FilePathLink } from '../../FilePathLink.js'
import { ContentDiff } from '../ContentDiff.js'

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

type EditInput = { path: string; oldText: string; newText: string }

export function EditToolView({
  input,
  output,
  status,
}: {
  input: EditInput
  output?: ToolResult
  status: string
}) {
  const path = input?.path ?? ''
  const oldText = input?.oldText ?? ''
  const newText = input?.newText ?? ''
  if (status === 'error' && output?._tag === 'error') {
    return (
      <div>
        <div className={title} data-testid="tool-title">
          <span className={name}>edit</span> · {path}
        </div>
        <div className={err} data-testid="tool-error">
          {output.error}
        </div>
      </div>
    )
  }
  return (
    <div>
      <div className={title} data-testid="tool-title">
        <span className={name}>edit</span>
      </div>
      <div className={title} data-testid="file-name">
        <FilePathLink path={path} />
      </div>
      <ContentDiff oldText={oldText} newText={newText} />
    </div>
  )
}
