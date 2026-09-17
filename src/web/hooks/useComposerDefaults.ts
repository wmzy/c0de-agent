import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelSelection } from '@/components/ModelSelector.js'
import { useConfig } from '@/contexts/ConfigContext.js'
import { providerAPI } from '@/services/provider.js'

const SELECTION_KEY = 'c0de-agent:modelSelection'
const AGENT_KEY = 'c0de-agent:selectedAgent'
const TOOLS_KEY = 'c0de-agent:enabledTools'

/** 按项目分桶的存储键；旧全局键做回退迁移（项目首次打开沿用全局选择一次）。 */
function selectionKey(projectId?: string): string {
  return projectId ? `${SELECTION_KEY}:${projectId}` : SELECTION_KEY
}

function agentKey(projectId?: string): string {
  return projectId ? `${AGENT_KEY}:${projectId}` : AGENT_KEY
}

function toolsKey(projectId?: string): string {
  return projectId ? `${TOOLS_KEY}:${projectId}` : TOOLS_KEY
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
  // P1-1：按项目读取配置——defaultModel/默认 provider 来自该项目合并配置。
  const { config } = useConfig(projectId)
  const { data: providersData } = useQuery({
    queryKey: ['providers', projectId],
    queryFn: () => providerAPI.list(projectId),
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
  // 用户是否在本次项目会话中操作过模型选择（输入/点选/切换 provider）。
  // 校正逻辑只作用于「未操作过」的选择值（持久化恢复/默认填充），避免与自由输入互搏。
  const selectionTouchedRef = useRef(false)
  const setAndPersistSelection = useCallback(
    (v: ModelSelection) => {
      selectionTouchedRef.current = true
      try {
        localStorage.setItem(selectionKey(projectId), JSON.stringify(v))
      } catch {
        // 忽略写入失败
      }
      setSelection(v)
    },
    [projectId],
  )

  /** 程序化校正/默认填充：同样落盘，但不视为用户操作（后续校正仍可继续）。 */
  const applyCorrectedSelection = useCallback(
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
  // P1-6：启用工具白名单按项目持久化——此前纯组件状态，切换会话/刷新
  // 静默回滚为「全部启用」。安全相关状态的无提示回滚比偏好丢失更危险。
  // null = 未显式选择（后端默认集）；Set = 显式选择（含空集 = 全禁用）。
  const [enabledTools, setEnabledToolsState] = useState<Set<string> | null>(() => {
    try {
      const raw = localStorage.getItem(toolsKey(projectId))
      if (raw == null) return null
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === 'string')) return null
      return new Set(parsed)
    } catch {
      return null
    }
  })
  const setEnabledTools = useCallback(
    (v: Set<string> | null) => {
      setEnabledToolsState(v)
      try {
        if (v === null) localStorage.removeItem(toolsKey(projectId))
        else localStorage.setItem(toolsKey(projectId), JSON.stringify(Array.from(v)))
      } catch {
        // 存储不可用（隐私模式等）：本次会话内仍生效
      }
    },
    [projectId],
  )
  const [agentName, setAgentNameState] = useState<string>(
    () => localStorage.getItem(agentKey(projectId)) ?? localStorage.getItem(AGENT_KEY) ?? 'default',
  )
  const setAgentName = (name: string) => {
    localStorage.setItem(agentKey(projectId), name)
    setAgentNameState(name)
  }

  // P1-6/P2：切换项目时重载该项目的持久化选择（selection/enabledTools/agentName）。
  // ChatPage 在项目间导航时组件实例复用，不重载会让上一个项目的工具白名单
  // 泄漏到当前项目（安全相关状态跨项目串味）。
  // P1-2：重载后的选择来自持久化/默认值（非用户操作），允许后续默认值校正。
  useEffect(() => {
    selectionTouchedRef.current = false
    try {
      const saved = localStorage.getItem(selectionKey(projectId))
      if (saved) setSelection(JSON.parse(saved) as ModelSelection)
      else setSelection({ provider: '', model: '' })
    } catch {
      setSelection({ provider: '', model: '' })
    }
    try {
      const rawTools = localStorage.getItem(toolsKey(projectId))
      if (rawTools == null) setEnabledToolsState(null)
      else {
        const parsed = JSON.parse(rawTools) as unknown
        setEnabledToolsState(
          Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')
            ? new Set(parsed)
            : null,
        )
      }
    } catch {
      setEnabledToolsState(null)
    }
    setAgentNameState(
      localStorage.getItem(agentKey(projectId)) ?? localStorage.getItem(AGENT_KEY) ?? 'default',
    )
  }, [projectId])

  // P1-2：默认值校正（provider 与 model 都要校正，此前只校正 provider）：
  // - provider：选择值/defaultProvider 不在已配置列表时回退首个已配置 provider；
  // - model：所选 provider 在 config 中声明了模型清单、且当前模型不在其中
  //   （典型首跑：defaultModel 仍是默认 'gpt-4o'，用户只配置了 Anthropic）→
  //   回退清单首项；未声明清单的 provider（自建网关）保持自由输入原值。
  // 仅在「用户未操作过」时校正（持久化恢复/默认填充）；用户输入期间不干预。
  // providersData 缺失（列表加载中）时跳过，避免用空列表误清持久化选择。
  useEffect(() => {
    if (!providersData || selectionTouchedRef.current) return
    const def = providersData.defaultProvider
    const provider =
      selection.provider && providers.some((p) => p.name === selection.provider)
        ? selection.provider
        : providers.some((p) => p.name === def)
          ? def
          : (providers[0]?.name ?? '')
    const provDef = config?.providers?.find((p) => p.name === provider)
    const declared = provDef?.models ? Object.keys(provDef.models) : undefined
    const preferred = selection.model || config?.defaultModel || ''
    let model = preferred
    if (declared && declared.length > 0 && !declared.includes(preferred)) {
      model = declared[0] ?? ''
    }
    if (provider !== selection.provider || model !== selection.model) {
      applyCorrectedSelection({ provider, model })
    }
  }, [
    providers,
    providersData,
    config,
    selection.provider,
    selection.model,
    applyCorrectedSelection,
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
