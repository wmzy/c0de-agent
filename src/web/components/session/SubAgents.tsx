import { css } from '@linaria/core'
import type { SubagentInfo } from '../../hooks/useChat.js'

const card = css`
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 8px;
  margin: 6px 0;
  font-size: 13px;
`

const statusColor = (status: SubagentInfo['status']): string => {
  switch (status) {
    case 'running':
      return 'var(--accent)'
    case 'completed':
      return 'var(--success, green)'
    case 'failed':
      return 'var(--danger, red)'
  }
}

/** 子 agent 进度列表（spec: multi-agent-design §4.5）。 */
export function SubAgents({ subagents }: { subagents: SubagentInfo[] }) {
  if (subagents.length === 0) return null
  return (
    <div data-testid="subagents-list">
      {subagents.map((s) => (
        <div key={s.childId} className={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>
              {s.agentType} · {s.description}
            </span>
            <span style={{ color: statusColor(s.status) }}>{s.status}</span>
          </div>
          <span style={{ color: 'var(--text-secondary)' }}>id: {s.childId.slice(0, 8)}</span>
        </div>
      ))}
    </div>
  )
}
