import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { ContentDiff } from '@/components/session/ContentDiff.js'

const err = css`
  font-size: 13px;
  color: var(--haze-color-danger);
  background: var(--haze-color-danger-subtle);
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
  const oldText = input?.oldText ?? ''
  const newText = input?.newText ?? ''
  if (status === 'error' && output?._tag === 'error') {
    return (
      <div className={err} data-testid="tool-error">
        {output.error}
      </div>
    )
  }
  return <ContentDiff oldText={oldText} newText={newText} />
}
