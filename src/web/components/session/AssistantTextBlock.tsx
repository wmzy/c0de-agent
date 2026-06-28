import { css } from '@linaria/core'
import { CopyButton } from '../CopyButton.js'
import { Markdown } from '../Markdown.js'
import { useOverflow } from './hooks/useOverflow.js'

const wrap = css`
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const body = css`
  font-size: 14px;
  line-height: 1.6;

  & pre {
    max-height: 300px;
    overflow: auto;
  }
`

const collapsed = css`
  max-height: 400px;
  overflow: hidden;
`

const btn = css`
  align-self: flex-start;
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

const footer = css`
  font-size: 12px;
  color: var(--text-secondary);
`

export function AssistantTextBlock({ text, completedAt }: { text: string; completedAt?: number }) {
  const { ref, overflowing, expanded, toggle } = useOverflow(400)
  const showToggle = overflowing && !expanded
  return (
    <div className={wrap} data-testid="assistant-text">
      <div ref={ref} className={`${body} ${showToggle ? collapsed : ''}`}>
        <Markdown content={text} />
      </div>
      {overflowing && (
        <button type="button" className={btn} onClick={toggle}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <CopyButton text={text} />
        {completedAt && (
          <span className={footer} data-testid="assistant-time">
            {new Date(completedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  )
}
