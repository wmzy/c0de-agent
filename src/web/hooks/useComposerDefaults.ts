import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { ModelSelection } from '../components/ModelSelector.js'
import { useConfig } from '../contexts/ConfigContext.js'
import { providerAPI } from '../services/provider.js'

/**
 * Composer 的默认 model 选择与启用工具白名单状态。
 * ChatSession（已有会话）与 DraftSession（草稿新会话）共用，避免重复实现默认值校正逻辑。
 *
 * 校正规则：defaultProvider 可能是 protocol 名（如 openai-compat），直传后端会 NoRoute；
 * 故不在已配置列表时回退首个已配置 provider。model 取 config.defaultModel。
 */
export function useComposerDefaults() {
  const { config } = useConfig()
  const { data: providersData } = useQuery({
    queryKey: ['providers'],
    queryFn: () => providerAPI.list(),
    staleTime: 60_000,
  })

  const providers = providersData?.providers ?? []
  const [selection, setSelection] = useState<ModelSelection>({ provider: '', model: '' })
  const [enabledTools, setEnabledTools] = useState<Set<string> | null>(null)

  useEffect(() => {
    if (selection.provider && selection.model) return
    const def = providersData?.defaultProvider
    const provider = providers.some((p) => p.name === def)
      ? def
      : (providers[0]?.name ?? selection.provider)
    const model = config?.defaultModel ?? selection.model
    if (provider !== selection.provider || model !== selection.model) {
      setSelection({ provider: provider || selection.provider, model: model || selection.model })
    }
  }, [providers, providersData, config, selection.provider, selection.model])

  return { selection, setSelection, enabledTools, setEnabledTools, providers, providersData }
}
