import { css } from '@linaria/core'
import { useState } from 'react'
import { Markdown } from '../Markdown.js'

const wrap = css`
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
`

const header = css`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  background: var(--bg-secondary);
  font-size: 13px;
  color: var(--text-secondary);
`

const body = css`
  padding: 8px 12px;
  font-size: 13px;
`

export function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={wrap} data-testid="reasoning" data-expanded={expanded}>
      <button
        type="button"
        className={header}
        data-testid="reasoning-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span>思考过程</span>
      </button>
      {expanded && (
        <div className={body}>
          <Markdown content={text} />
        </div>
      )}
    </div>
  )
}
