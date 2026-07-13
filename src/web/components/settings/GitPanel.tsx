import type { Config } from '@shared/types/config.js'
import type { ProviderConfig } from '@shared/types/llm.js'
import { enabledModelsOf, providerCandidates } from './shared.js'
import { checkRow, field, fieldInput, section } from './styles.js'

interface GitPanelProps {
  /** commitModel 配置（undefined 表示用默认模型）。 */
  commitModel: Config['commitModel']
  /** 候选 provider 列表（用于 commit 模型的 provider 下拉）。 */
  providers: ProviderConfig[]
  /** 启用「提交独立模型」时的默认 provider/model。 */
  defaultProvider: string
  defaultModel: string
  onCommitModelChange: (patch: { commitModel: Config['commitModel'] }) => void
}

/** Git 配置：一键提交使用的独立模型（commit message 生成可指定便宜模型）。 */
function GitPanel({
  commitModel,
  providers,
  defaultProvider,
  defaultModel,
  onCommitModelChange,
}: GitPanelProps) {
  const candidates = providerCandidates(providers)
  const cm = commitModel

  return (
    <div className={section}>
      <h3>Git 提交</h3>
      <label className={checkRow}>
        <input
          type="checkbox"
          checked={cm !== undefined}
          onChange={(e) =>
            onCommitModelChange({
              commitModel: e.target.checked
                ? { provider: defaultProvider, model: defaultModel }
                : undefined,
            })
          }
        />
        <span>一键提交使用独立模型（commit message 生成可指定便宜/快速模型）</span>
      </label>
      {cm && (
        <>
          <label className={field}>
            <span>提交 Provider：</span>
            <select
              className={fieldInput}
              value={cm.provider}
              onChange={(e) => {
                const firstModel = enabledModelsOf(providers, e.target.value)[0] ?? cm.model
                onCommitModelChange({
                  commitModel: { provider: e.target.value, model: firstModel },
                })
              }}
              data-testid="commit-provider-select"
            >
              {candidates.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            <span>提交 Model：</span>
            <select
              className={fieldInput}
              value={cm.model}
              onChange={(e) =>
                onCommitModelChange({
                  commitModel: { provider: cm.provider, model: e.target.value },
                })
              }
              data-testid="commit-model-select"
            >
              {(() => {
                const models = enabledModelsOf(providers, cm.provider)
                if (models.length === 0) return <option value="">该 Provider 暂无模型</option>
                return models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))
              })()}
            </select>
          </label>
        </>
      )}
    </div>
  )
}

export { GitPanel }
