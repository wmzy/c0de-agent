import type { ProviderConfig } from '@shared/types/llm.js'

/**
 * Settings 子面板共用的纯函数（无 CSS、无副作用）。
 */

/** 获取指定 provider 下已启用的模型列表（空数组表示无可用模型）。 */
function enabledModelsOf(providers: ProviderConfig[], providerName: string): string[] {
  const entry = providers.find((p) => p.name === providerName)
  return entry?.models
    ? Object.entries(entry.models)
        .filter(([, v]) => v.enabled !== false)
        .map(([name]) => name)
    : []
}

/** 作为候选的 provider：名称非空者（用于默认 / 压缩模型下拉）。 */
function providerCandidates(providers: ProviderConfig[]): ProviderConfig[] {
  return providers.filter((p) => p.name.trim() !== '')
}

export { enabledModelsOf, providerCandidates }
