import { css } from '@linaria/core'
import type { AgentListItem } from '../services/agent.js'
import { inputStyle } from '../styles/tokens.js'

/** 控件增量样式（自包含 min-height，否则被全局 select{min-height:44px} 覆盖；边框/圆角/背景/文字色来自 inputStyle）。 */
const selectControl = css`
  padding: 4px 28px 4px 8px;
  min-height: 28px;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
`

/** Primary agent 切换器：下拉选择 default/plan 等 primary agent。 */
export function AgentSelector({
  value,
  onChange,
  agents,
}: {
  value: string
  onChange: (name: string) => void
  agents: AgentListItem[]
}) {
  const primary = agents.filter((a) => a.mode !== 'subagent')
  return (
    <select
      className={`${inputStyle} ${selectControl}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="切换 agent"
      data-testid="agent-selector"
    >
      {primary.map((a) => (
        <option key={a.name} value={a.name}>
          {a.name}
        </option>
      ))}
    </select>
  )
}
