import { css } from '@linaria/core'

/** 后端 SubAgentEvent 类型（spec §2.10 定义，后端尚未实现）。 */
type SubAgentEvent = {
  parentId: string
  childId: string
  childSessionId: string
  event: { _tag: string }
}

type SubAgentProgressProps = {
  childId: string
  childSessionId: string
  events: SubAgentEvent[]
  onAbort?: () => void
}

const card = css`
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 8px;
  margin: 6px 0;
  font-size: 13px;
`

const rowBetween = css`
  display: flex;
  justify-content: space-between;
`

const muted = css`
  color: var(--text-secondary);
`

export function SubAgentProgress({
  childId,
  childSessionId,
  events,
  onAbort,
}: SubAgentProgressProps) {
  if (events.length === 0) return null
  const toolCount = events.filter((e) => e.event._tag === 'tool_call_start').length
  return (
    <div className={card} data-testid="subagent-progress">
      <div className={rowBetween}>
        <span>子 Agent {childId.slice(0, 8)}</span>
        {onAbort && (
          <button type="button" onClick={onAbort}>
            中止
          </button>
        )}
      </div>
      <span className={muted}>
        session: {childSessionId.slice(0, 8)} · {toolCount} 次工具调用
      </span>
    </div>
  )
}
