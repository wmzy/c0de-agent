import type { Config } from '@shared/types/config.js'
import { SyncedInput } from '@/components/SyncedControls.js'
import { checkRow, field, fieldInput, section, sectionTitle } from '@/components/settings/styles.js'

interface AssistPanelProps {
  assist: Config['assist']
  onAssistChange: (patch: Partial<NonNullable<Config['assist']>>) => void
}

/** 交互辅助（assist.*，oh-my-pi 口径迁移）：空输入预测 + 离场回顾。两项都默认
 *  关闭——每次触发都是一次额外计费的 LLM 请求（预测=每轮一次；回顾=空闲一次，
 *  时间线未新增时命中缓存不再计费），用户显式开启。 */
function AssistPanel({ assist, onAssistChange }: AssistPanelProps) {
  const a = assist ?? { predictionEnabled: false, recapEnabled: false, recapIdleSeconds: 240 }
  return (
    <div className={section}>
      <h2 className={sectionTitle}>交互辅助</h2>
      <label className={checkRow}>
        <input
          type="checkbox"
          checked={a.predictionEnabled}
          onChange={(e) => onAssistChange({ predictionEnabled: e.target.checked })}
          data-testid="assist-prediction-toggle"
        />
        <span>输入预测（每轮结束后预测下一条消息，空输入框以灰色文本预填，→ 采纳）</span>
      </label>
      <label className={checkRow}>
        <input
          type="checkbox"
          checked={a.recapEnabled}
          onChange={(e) => onAssistChange({ recapEnabled: e.target.checked })}
          data-testid="assist-recap-toggle"
        />
        <span>离场回顾（空闲后在时间线底部生成一行现状与下一步）</span>
      </label>
      <label className={field}>
        <span>回顾空闲秒数</span>
        <SyncedInput
          className={fieldInput}
          type="number"
          min={1}
          value={String(a.recapIdleSeconds)}
          onChange={(v) =>
            onAssistChange({
              recapIdleSeconds: Math.max(1, Number.parseInt(v, 10) || a.recapIdleSeconds),
            })
          }
        />
      </label>
      <p className={field}>两项启用后都会产生额外模型调用费用（按会话当前模型计费）。</p>
    </div>
  )
}

export { AssistPanel }
