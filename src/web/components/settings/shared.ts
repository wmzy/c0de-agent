import type { ProviderConfig } from '@shared/types/llm.js'

/**
 * Settings 子面板共用的纯函数（无 CSS、无副作用）。
 */

/** 获取 provider 在 config 中声明的「已启用模型」清单。未声明清单（自建网关等）
 *  返回 undefined——用于区分「清单里没有这个模型」与「此 provider 不限定模型」。
 *  ModelSelector 的输入建议与 provider 切换校正、Settings 的默认模型候选共用。 */
function declaredModels(providers: ProviderConfig[], providerName: string): string[] | undefined {
  const entry = providers.find((p) => p.name === providerName)
  if (!entry?.models) return undefined
  // 仅列出启用的模型（enabled 省略/true 视为启用）
  return Object.entries(entry.models)
    .filter(([, v]) => v.enabled !== false)
    .map(([name]) => name)
}

/** 获取指定 provider 下已启用的模型列表（空数组表示无可用模型）。 */
function enabledModelsOf(providers: ProviderConfig[], providerName: string): string[] {
  return declaredModels(providers, providerName) ?? []
}

/** 作为候选的 provider：名称非空者（用于默认 / 压缩模型下拉）。
 *  name 可为空（旧格式仅有 _tag），此时跳过，避免 .trim 崩溃。 */
function providerCandidates(providers: ProviderConfig[]): ProviderConfig[] {
  return providers.filter((p) => (p.name ?? '').trim() !== '')
}

export { declaredModels, enabledModelsOf, providerCandidates }
