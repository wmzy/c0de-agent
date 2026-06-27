import { css } from '@linaria/core'
import type { LLMDetail } from '@shared/types/agent.js'
import { formatLatency } from '../utils/format.js'

const card = css`
  border: 1px solid var(--border);
  border-radius: 6px;
  margin: 8px 0;
  font-size: 13px;
`

const header = css`
  display: flex;
  gap: 12px;
  padding: 8px;
  background: var(--bg-secondary);
  flex-wrap: wrap;
`

export function LLMDetailPanel({ detail }: { detail: LLMDetail }) {
  return (
    <div className={card} data-testid="llm-detail">
      <div className={header}>
        <span>{detail.model}</span>
        <span style={{ color: 'var(--text-secondary)' }}>{detail.provider}</span>
        <span>
          {detail.usage.input} → {detail.usage.output}
        </span>
        <span style={{ color: 'var(--text-secondary)' }}>
          {formatLatency(detail.latency.total)}
        </span>
      </div>
      <details>
        <summary>System Prompt</summary>
        <pre style={{ padding: 8, maxHeight: 200, overflow: 'auto' }}>{detail.systemPrompt}</pre>
      </details>
      <details>
        <summary>Response</summary>
        <pre style={{ padding: 8 }}>
          {detail.responseChunks.map((c) => ('text' in c ? c.text : '')).join('')}
        </pre>
      </details>
    </div>
  )
}
