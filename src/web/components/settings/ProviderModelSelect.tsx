import type { ProviderConfig } from '@shared/types/llm.js'
import { SyncedSelect } from '@/components/SyncedControls.js'
import { enabledModelsOf, providerCandidates } from '@/components/settings/shared.js'
import { field, fieldInput } from '@/components/settings/styles.js'

interface ProviderModelValue {
  provider: string
  model: string
}

interface ProviderModelSelectProps {
  value: ProviderModelValue
  onChange: (v: ProviderModelValue) => void
  providers: ProviderConfig[]
  providerLabel: string
  modelLabel: string
  providerTestId?: string
  modelTestId?: string
}

/** Provider + Model 双下拉选择器，provider 变更时自动切到其首个启用模型。 */
function ProviderModelSelect({
  value,
  onChange,
  providers,
  providerLabel,
  modelLabel,
  providerTestId,
  modelTestId,
}: ProviderModelSelectProps) {
  const candidates = providerCandidates(providers)

  return (
    <>
      <label className={field}>
        <span>{providerLabel}</span>
        <SyncedSelect
          className={fieldInput}
          value={value.provider}
          onValuesChange={(v) => {
            const firstModel = enabledModelsOf(providers, v as string)[0] ?? value.model
            onChange({ provider: v as string, model: firstModel })
          }}
          data-testid={providerTestId}
        >
          {candidates.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </SyncedSelect>
      </label>
      <label className={field}>
        <span>{modelLabel}</span>
        <SyncedSelect
          className={fieldInput}
          value={value.model}
          onValuesChange={(v) => onChange({ provider: value.provider, model: v as string })}
          data-testid={modelTestId}
        >
          {(() => {
            const models = enabledModelsOf(providers, value.provider)
            if (models.length === 0) return <option value="">该 Provider 暂无模型</option>
            return models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))
          })()}
        </SyncedSelect>
      </label>
    </>
  )
}

export type { ProviderModelSelectProps, ProviderModelValue }
export { ProviderModelSelect }
