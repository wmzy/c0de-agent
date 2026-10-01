import { css } from '@linaria/core'
import { memo, useMemo } from 'react'
import { CodeReference } from '@/components/CodeReference.js'
import { CopyButton } from '@/components/CopyButton.js'
import { Markdown } from '@/components/Markdown.js'
import { useOverflow } from '@/components/session/hooks/useOverflow.js'
import { formatLatency } from '@/utils/format.js'

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
  /* 折叠边缘遮罩淡出（不硬截半行），mask 与本底颜色无关、明暗主题同样成立 */
  -webkit-mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 3.2em), transparent);
  mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 3.2em), transparent);
`

const btn = css`
  align-self: flex-start;
  font-size: 12px;
  color: var(--haze-color-primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

const footer = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

const footerRow = css`
  display: flex;
  align-items: center;
  gap: 8px;
`

const refPattern = /^@\[[^:]+:\d+(-\d+)?\]$/

function collectCodeRefs(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => refPattern.test(l))
}

export const AssistantTextBlock = memo(function AssistantTextBlock({
  text,
  completedAt,
  latency,
  forceExpand,
}: {
  text: string
  completedAt?: number
  latency?: number
  forceExpand?: boolean
}) {
  const { ref, overflowing, expanded, toggle } = useOverflow(400)
  const isExpanded = forceExpand || expanded
  const showToggle = overflowing && !isExpanded
  const refTokens = useMemo(() => collectCodeRefs(text), [text])
  return (
    <div className={wrap} data-testid="assistant-text">
      <div ref={ref} className={`${body} ${showToggle ? collapsed : ''}`}>
        <Markdown content={text} />
        {refTokens.length > 0 && (
          <div data-testid="assistant-code-refs">
            {refTokens.map((t) => (
              <CodeReference key={t} token={t} />
            ))}
          </div>
        )}
      </div>
      {overflowing && (
        <button type="button" className={btn} onClick={toggle}>
          {isExpanded ? '收起' : '展开'}
        </button>
      )}
      <div className={footerRow}>
        <CopyButton text={text} />
        {(completedAt || latency != null) && (
          <span className={footer} data-testid="assistant-time">
            {completedAt && new Date(completedAt).toLocaleString()}
            {completedAt && latency != null && ' · '}
            {latency != null && formatLatency(latency)}
          </span>
        )}
      </div>
    </div>
  )
})
