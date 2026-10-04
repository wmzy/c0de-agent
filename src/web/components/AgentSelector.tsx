import { SyncedSelect } from '@/components/SyncedControls.js'
import type { AgentListItem } from '@/services/agent.js'
import { compactSelect, inputStyle } from '@/styles/tokens.js'

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
    <SyncedSelect
      className={`${inputStyle} ${compactSelect}`}
      value={value}
      onValuesChange={(v) => onChange(v as string)}
      aria-label="切换 agent"
      data-testid="agent-selector"
    >
      {primary.map((a) => (
        <option key={a.name} value={a.name}>
          {a.name}
        </option>
      ))}
    </SyncedSelect>
  )
}
