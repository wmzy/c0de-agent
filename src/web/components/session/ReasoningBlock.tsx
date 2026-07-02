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

const title = css`
  flex-shrink: 0;
`

const preview = css`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  opacity: 0.7;
`

const body = css`
  padding: 8px 12px;
  font-size: 13px;
`

/** 取思考文本的最后一个非空行，作为折叠态预览。 */
function lastNonEmptyLine(text: string): string {
  const line = text.trimEnd().split('\n').pop() ?? ''
  return line.trim()
}

export function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const previewLine = expanded ? '' : lastNonEmptyLine(text)
  return (
    <div className={wrap} data-testid="reasoning" data-expanded={expanded}>
      <button
        type="button"
        className={header}
        data-testid="reasoning-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span className={title}>思考过程</span>
        {previewLine && (
          <span className={preview} data-testid="reasoning-preview">
            {previewLine}
          </span>
        )}
      </button>
      {expanded && (
        <div className={body}>
          <Markdown content={text} />
        </div>
      )}
    </div>
  )
}
