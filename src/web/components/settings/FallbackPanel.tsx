import type { Config } from '@shared/types/config.js'
import { checkRow, field, fieldInput, hint, section, sectionTitle } from './styles.js'

interface FallbackPanelProps {
  fallback: Config['fallback']
  onFallbackChange: (patch: Partial<Config['fallback']>) => void
}

/** 故障回退配置：启用开关、最大重试次数与重试间隔。
 *  已接入主对话/压缩/标题生成的全部 LLM 调用：
 *  启用后按此处的重试参数执行，并在主 provider 失败时依次回退到声明了同一模型的
 *  其他 provider（未声明模型的 provider 不会被回退，避免无效调用）。 */
function FallbackPanel({ fallback, onFallbackChange }: FallbackPanelProps) {
  return (
    <div className={section}>
      <h2 className={sectionTitle}>故障回退</h2>
      <div className={hint}>
        主 provider 失败时自动重试；启用后还会回退到其他声明了同一模型的 provider。
      </div>
      <label className={checkRow}>
        <input
          type="checkbox"
          checked={fallback.enabled}
          onChange={(e) => onFallbackChange({ enabled: e.target.checked })}
        />
        <span>启用自动重试与回退</span>
      </label>
      <label className={field}>
        <span>最大重试次数</span>
        <input
          className={fieldInput}
          type="number"
          min={0}
          value={fallback.maxRetries}
          onChange={(e) => onFallbackChange({ maxRetries: Number(e.target.value) })}
        />
      </label>
      <label className={field}>
        <span>重试间隔 (ms)</span>
        <input
          className={fieldInput}
          type="number"
          min={0}
          value={fallback.retryDelay}
          onChange={(e) => onFallbackChange({ retryDelay: Number(e.target.value) })}
        />
      </label>
    </div>
  )
}

export { FallbackPanel }
