import type { Config } from '@shared/types/config.js'
import type { ProviderConfig } from '@shared/types/llm.js'
import { ProviderModelSelect } from './ProviderModelSelect.js'
import { checkRow, field, fieldInput, section, sectionTitle } from './styles.js'

interface CompactionPanelProps {
  compaction: Config['compaction']
  /** 候选 provider 列表（用于压缩模型的 provider 下拉）。 */
  providers: ProviderConfig[]
  /** 启用「压缩独立模型」时的默认 provider/model。 */
  defaultProvider: string
  defaultModel: string
  onCompactionChange: (patch: Partial<Config['compaction']>) => void
}

/** 上下文压缩配置：阈值/保留 token/中轮压缩，以及可选的独立压缩模型。 */
function CompactionPanel({
  compaction,
  providers,
  defaultProvider,
  defaultModel,
  onCompactionChange,
}: CompactionPanelProps) {
  const cm = compaction.compactionModel

  return (
    <div className={section}>
      <h2 className={sectionTitle}>上下文压缩</h2>
      <label className={checkRow}>
        <input
          type="checkbox"
          checked={compaction.enabled}
          onChange={(e) => onCompactionChange({ enabled: e.target.checked })}
        />
        <span>启用自动压缩</span>
      </label>
      <label className={field}>
        <span>触发阈值：</span>
        <input
          className={fieldInput}
          type="number"
          step="0.05"
          min={0}
          max={1}
          value={compaction.threshold}
          onChange={(e) => onCompactionChange({ threshold: Number(e.target.value) })}
        />
      </label>
      <label className={field}>
        <span>保留 Token：</span>
        <input
          className={fieldInput}
          type="number"
          min={0}
          value={compaction.reserveTokens}
          onChange={(e) => onCompactionChange({ reserveTokens: Number(e.target.value) })}
        />
      </label>
      <label className={field}>
        <span>近期保留 Token：</span>
        <input
          className={fieldInput}
          type="number"
          min={0}
          value={compaction.keepRecentTokens}
          onChange={(e) => onCompactionChange({ keepRecentTokens: Number(e.target.value) })}
        />
      </label>
      <label className={checkRow}>
        <input
          type="checkbox"
          checked={compaction.midTurnEnabled === true}
          onChange={(e) => onCompactionChange({ midTurnEnabled: e.target.checked })}
        />
        <span>中轮压缩（工具执行后、下次 LLM 请求前按阈值静默压缩）</span>
      </label>
      <label className={checkRow}>
        <input
          type="checkbox"
          checked={compaction.compactionModel !== undefined}
          onChange={(e) =>
            onCompactionChange({
              compactionModel: e.target.checked
                ? { provider: defaultProvider, model: defaultModel }
                : undefined,
            })
          }
        />
        <span>压缩使用独立模型（摘要任务对推理要求低，可指定便宜模型）</span>
      </label>
      {cm && (
        <ProviderModelSelect
          value={cm}
          onChange={(v) => onCompactionChange({ compactionModel: v })}
          providers={providers}
          providerLabel="压缩 Provider："
          modelLabel="压缩 Model："
          providerTestId="compaction-provider-select"
          modelTestId="compaction-model-select"
        />
      )}
    </div>
  )
}

export { CompactionPanel }
