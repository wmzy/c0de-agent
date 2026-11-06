// 聊天输入区三件套（agent 切换 + model 切换 + 工具白名单开关）：
// ChatSession（已有会话）与 ChatView 的 DraftSession（草稿新会话）曾成对复制
// 这两段 JSX 与 ['agents'] 查询（仅 disabled 取值不同：isStreaming vs creating），
// 收敛于此（与 recycleStyles.ts 同款 _shared 约定）。
// Chat 的 footer 是两个独立插槽（footerLeft=modelBar / footerRight=toolToggle），
// 单个组件无法同时占位，故以 hook 一次产出两段节点，页面照旧分别传入
// modelBar/toolToggle props——对 AgentSelector/ModelSelector/ToolToggle 的
// props 透传与 testid 完全不变。
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { AgentSelector } from '@/components/AgentSelector.js'
import { type ModelSelection, ModelSelector } from '@/components/ModelSelector.js'
import { ToolToggle } from '@/components/ToolToggle.js'
import { agentAPI } from '@/services/agent.js'

/** agent 清单查询：两页共用（页面级 Chat 的 agents prop 与 useComposerBar 内部
 *  各订阅一次；同一 queryKey 由 react-query 去重，不会重复请求）。 */
export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => agentAPI.listAgents(),
    staleTime: 60_000,
  })
}

export function useComposerBar({
  projectId,
  agentName,
  onAgentNameChange,
  selection,
  onSelectionChange,
  enabledTools,
  onEnabledToolsChange,
  disabled,
}: {
  projectId: string
  agentName: string
  onAgentNameChange: (name: string) => void
  selection: ModelSelection
  onSelectionChange: (v: ModelSelection) => void
  enabledTools: Set<string> | null
  onEnabledToolsChange: (v: Set<string> | null) => void
  /** 工具开关禁用：会话页传 chat.isStreaming（运行中），草稿页传 creating（首条消息建会话在途）。 */
  disabled: boolean
}): { modelBar: ReactNode; toolToggle: ReactNode } {
  const {
    data: agentsData,
    isError: agentsFailed,
    error: agentsError,
    refetch: refetchAgents,
  } = useAgents()
  return {
    modelBar: (
      <>
        <AgentSelector
          value={agentName}
          onChange={onAgentNameChange}
          agents={agentsData?.agents ?? []}
          error={agentsFailed ? agentsError : null}
          onRetry={() => void refetchAgents()}
        />
        <ModelSelector value={selection} onChange={onSelectionChange} projectId={projectId} />
      </>
    ),
    toolToggle: (
      <ToolToggle
        enabled={enabledTools}
        onChange={onEnabledToolsChange}
        disabled={disabled}
        projectId={projectId}
      />
    ),
  }
}
