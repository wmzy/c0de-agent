import type { Config } from '@shared/types/config.js'
import type { ProviderConfig } from '@shared/types/llm.js'
import { ProviderModelSelect } from './ProviderModelSelect.js'
import { checkRow, section, sectionTitle } from './styles.js'

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
  const cm = commitModel

  return (
    <div className={section}>
      <h2 className={sectionTitle}>Git 提交</h2>
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
        <ProviderModelSelect
          value={cm}
          onChange={(v) => onCommitModelChange({ commitModel: v })}
          providers={providers}
          providerLabel="提交 Provider："
          modelLabel="提交 Model："
          providerTestId="commit-provider-select"
          modelTestId="commit-model-select"
        />
      )}
    </div>
  )
}

export { GitPanel }
