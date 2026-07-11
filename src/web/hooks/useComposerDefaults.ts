import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import type { ModelSelection } from '../components/ModelSelector.js'
import { useConfig } from '../contexts/ConfigContext.js'
import { providerAPI } from '../services/provider.js'

const SELECTION_KEY = 'c0de-agent:modelSelection'

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
  const [selection, setSelection] = useState<ModelSelection>(() => {
    // 从 localStorage 恢复上次选择，避免刷新/重挂载后 model 回到默认值
    try {
      const saved = localStorage.getItem(SELECTION_KEY)
      if (saved) return JSON.parse(saved) as ModelSelection
    } catch {
      // localStorage 不可用或 JSON 损坏，回退到默认值
    }
    return { provider: '', model: '' }
  })
  const setAndPersistSelection = useCallback((v: ModelSelection) => {
    try {
      localStorage.setItem(SELECTION_KEY, JSON.stringify(v))
    } catch {
      // 忽略写入失败
    }
    setSelection(v)
  }, [])
  const [enabledTools, setEnabledTools] = useState<Set<string> | null>(null)
  const [agentName, setAgentNameState] = useState<string>(
    () => localStorage.getItem('c0de-agent:selectedAgent') ?? 'default',
  )
  const setAgentName = (name: string) => {
    localStorage.setItem('c0de-agent:selectedAgent', name)
    setAgentNameState(name)
  }

  useEffect(() => {
    if (selection.provider && selection.model) return
    const def = providersData?.defaultProvider
    const provider = providers.some((p) => p.name === def)
      ? def
      : (providers[0]?.name ?? selection.provider)
    const model = config?.defaultModel ?? selection.model
    if (provider !== selection.provider || model !== selection.model) {
      setAndPersistSelection({
        provider: provider || selection.provider,
        model: model || selection.model,
      })
    }
  }, [
    providers,
    providersData,
    config,
    selection.provider,
    selection.model,
    setAndPersistSelection,
  ])

  return {
    selection,
    setSelection: setAndPersistSelection,
    enabledTools,
    setEnabledTools,
    agentName,
    setAgentName,
    providers,
    providersData,
  }
}
