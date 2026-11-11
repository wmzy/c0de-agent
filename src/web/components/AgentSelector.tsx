import { LoadErrorNotice } from '@/components/LoadErrorNotice.js'
import { SyncedSelect } from '@/components/SyncedControls.js'
import type { AgentListItem } from '@/services/agent.js'
import { compactSelect, inputStyle } from '@/styles/tokens.js'
import { messageOf } from '@/utils/errors.js'

/** Primary agent 切换器：下拉选择 default/plan 等 primary agent。
 *
 *  error 有值时（GET /api/agents 失败）不再渲染下拉：零 option 的空下拉与「一个
 *  agent 都没有」完全同形——用户看不到自己上次选的 agent（后端其实仍以该 agent
 *  在跑），也无法切换，页面上没有任何原因与重试入口。取不到清单是「拉不到」，
 *  不是「没有」；与 ModelSelector 的三段式口径一致。 */
export function AgentSelector({
  value,
  onChange,
  agents,
  error,
  onRetry,
}: {
  value: string
  onChange: (name: string) => void
  agents: AgentListItem[]
  /** agent 清单查询的失败原因（react-query 的 error）；有值即只报错不下拉。 */
  error?: unknown
  onRetry?: () => void
}) {
  if (error) {
    return (
      <LoadErrorNotice
        message={`agent 列表读取失败：${messageOf(error)}`}
        onRetry={onRetry}
        testId="agent-selector-load-error"
      />
    )
  }
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
