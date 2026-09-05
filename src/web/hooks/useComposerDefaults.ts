import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import type { ModelSelection } from '../components/ModelSelector.js'
import { useConfig } from '../contexts/ConfigContext.js'
import { providerAPI } from '../services/provider.js'

const SELECTION_KEY = 'c0de-agent:modelSelection'
const AGENT_KEY = 'c0de-agent:selectedAgent'

/** 按项目分桶的存储键；旧全局键做回退迁移（项目首次打开沿用全局选择一次）。 */
function selectionKey(projectId?: string): string {
  return projectId ? `${SELECTION_KEY}:${projectId}` : SELECTION_KEY
}

function agentKey(projectId?: string): string {
  return projectId ? `${AGENT_KEY}:${projectId}` : AGENT_KEY
}

/**
 * Composer 的默认 model 选择与启用工具白名单状态。
 * ChatSession（已有会话）与 DraftSession（草稿新会话）共用，避免重复实现默认值校正逻辑。
 *
 * P2：model/agent 选择按项目分桶持久化——此前全局单键，项目 A 切的模型泄漏到项目 B。
 * 旧全局键作为首访回退（迁移后写项目键，全局键不再更新）。
 *
 * 校正规则：defaultProvider 可能是 protocol 名（如 openai-compat），直传后端会 NoRoute；
 * 故不在已配置列表时回退首个已配置 provider。model 取 config.defaultModel。
 */
export function useComposerDefaults(projectId?: string) {
  const { config } = useConfig()
  const { data: providersData } = useQuery({
    queryKey: ['providers'],
    queryFn: () => providerAPI.list(),
    staleTime: 60_000,
  })

  const providers = providersData?.providers ?? []
  const [selection, setSelection] = useState<ModelSelection>(() => {
    // 从 localStorage 恢复上次选择（项目优先，旧全局键回退），避免刷新/重挂载后 model 回到默认值
    try {
      const saved = localStorage.getItem(selectionKey(projectId))
      const fallback = saved ?? localStorage.getItem(SELECTION_KEY)
      if (fallback) return JSON.parse(fallback) as ModelSelection
    } catch {
      // localStorage 不可用或 JSON 损坏，回退到默认值
    }
    return { provider: '', model: '' }
  })
  const setAndPersistSelection = useCallback(
    (v: ModelSelection) => {
      try {
        localStorage.setItem(selectionKey(projectId), JSON.stringify(v))
      } catch {
        // 忽略写入失败
      }
      setSelection(v)
    },
    [projectId],
  )
  const [enabledTools, setEnabledTools] = useState<Set<string> | null>(null)
  const [agentName, setAgentNameState] = useState<string>(
    () => localStorage.getItem(agentKey(projectId)) ?? localStorage.getItem(AGENT_KEY) ?? 'default',
  )
  const setAgentName = (name: string) => {
    localStorage.setItem(agentKey(projectId), name)
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
