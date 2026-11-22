// Advisor 配置解析（接线用单一出口）：config.advisor → 收紧后的运行时设置。
//
// 不直接读 config.advisor 的原因与 memory/settings.ts 相同：DEFAULT_CONFIG
// 合并后理应结构完整，但手改/旧版 config.json、测试自构 Config、部分覆写
// （只写 advisor.enabled）都会产生缺字段/非法值——advisor 是 fire-and-forget
// 后台管线，NaN 传播会变成静默失效，这里集中兜底/clamp。

import { resolveModelOverride } from '../memory/llm-call.js'
import type { AdvisorConfig, Config } from '../shared/types/config.js'
import {
  ADVISOR_DEFAULT_BUDGET_PER_UPDATE,
  ADVISOR_DEFAULT_IMMUNE_TURNS,
  ADVISOR_MAX_BUDGET_PER_UPDATE,
} from './emission-guard.js'

export interface AdvisorSettings {
  enabled: boolean
  /** 已解析的审查模型（advisor.model 覆盖，否则 defaultProvider/defaultModel）。 */
  model: { provider: string; model: string }
  maxNotesPerUpdate: number
  immuneTurns: number
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** config.advisor → 运行时设置（缺省/非法字段回退默认；model 一并解析成
 *  最终 provider/model，消费方不再自行回退）。 */
export function resolveAdvisorSettings(
  config: Pick<Config, 'advisor' | 'defaultProvider' | 'defaultModel'>,
): AdvisorSettings {
  const raw = config?.advisor as Partial<AdvisorConfig> | undefined
  return {
    enabled: raw?.enabled === true,
    model: resolveModelOverride(raw?.model) ?? {
      provider: config.defaultProvider,
      model: config.defaultModel,
    },
    maxNotesPerUpdate: intIn(
      raw?.maxNotesPerUpdate,
      1,
      ADVISOR_MAX_BUDGET_PER_UPDATE,
      ADVISOR_DEFAULT_BUDGET_PER_UPDATE,
    ),
    immuneTurns: intIn(raw?.immuneTurns, 0, Number.MAX_SAFE_INTEGER, ADVISOR_DEFAULT_IMMUNE_TURNS),
  }
}
