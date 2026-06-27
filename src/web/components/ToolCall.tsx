import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { useState } from 'react'

const card = css`
  border: 1px solid var(--border);
  border-radius: 6px;
  margin: 6px 0;
  font-size: 13px;
`

const summary = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
  background: var(--bg-secondary);
`

export function ToolCall({
  name,
  input,
  result,
}: {
  name: string
  input: unknown
  result?: ToolResult
}) {
  const [open, setOpen] = useState(false)
  const statusIcon = result
    ? result._tag === 'success'
      ? '✓'
      : result._tag === 'error'
        ? '✗'
        : '·'
    : '⏳'
  return (
    <div className={card}>
      <button className={summary} onClick={() => setOpen((v) => !v)} type="button">
        <span>{statusIcon}</span>
        <span>{name}</span>
      </button>
      {open && (
        <div style={{ padding: '8px' }}>
          <pre>{JSON.stringify(input, null, 2)}</pre>
          {result && result._tag !== 'permission_required' && (
            <pre>{'output' in result ? result.output : 'error' in result ? result.error : ''}</pre>
          )}
        </div>
      )}
    </div>
  )
}
