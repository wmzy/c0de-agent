import type { Config } from '@shared/types/config.js'
import { checkRow, field, fieldInput, section, sectionTitle } from './styles.js'

interface FallbackPanelProps {
  fallback: Config['fallback']
  onFallbackChange: (patch: Partial<Config['fallback']>) => void
}

/** 故障回退配置：启用开关、最大重试次数与重试间隔。 */
function FallbackPanel({ fallback, onFallbackChange }: FallbackPanelProps) {
  return (
    <div className={section}>
      <h2 className={sectionTitle}>故障回退</h2>
      <label className={checkRow}>
        <input
          type="checkbox"
          checked={fallback.enabled}
          onChange={(e) => onFallbackChange({ enabled: e.target.checked })}
        />
        <span>启用自动重试与回退</span>
      </label>
      <label className={field}>
        <span>最大重试次数：</span>
        <input
          className={fieldInput}
          type="number"
          min={0}
          value={fallback.maxRetries}
          onChange={(e) => onFallbackChange({ maxRetries: Number(e.target.value) })}
        />
      </label>
      <label className={field}>
        <span>重试间隔 (ms)：</span>
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
