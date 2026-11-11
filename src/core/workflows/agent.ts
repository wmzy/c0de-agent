// 工作流 runner 的 AgentConfig 单点组装。
//
// 此前 CLI 斜杠通道（core/slash.ts 的 /workflow run）与 Web/REST 共享通道
// （server/routes/workflow-run.ts 的 runWorkflowChannel）各持一份逐字同构的
// provider/model/tools 过滤/plugins 组装——同构副本必然漂移，收敛于此。
//
// 语义以两份原实现的共同口径为准：
// - provider/model 取会话级配置的默认值；runner 自身不进 agentLoop，无 LLM
//   调用影响，该配置是子 agent 工具集的交集基准与 createAgent 的兜底。
// - tools 走 resolveEnabledToolNames：config.tools.enabled 的 fail-closed 语义
//   对工作流派发的子 agent 成立（全禁 → 交集为空）；无项目绑定时剔除
//   项目专属工具（其运行时依赖宿主按 session.projectId 注入）。
// - plugins/agentName 与主 chat 同口径。

import type { AgentConfig } from '../../shared/types/agent.js'
import type { Config } from '../../shared/types/config.js'
import {
  PROJECT_BOUND_TOOLS,
  resolveEnabledToolNames,
  type ToolRegistry,
} from '../../tools/index.js'

/** 组装工作流 runner 的 AgentConfig（/workflow run 两通道共用，见模块注释）。 */
export function buildWorkflowAgentConfig(
  config: Config,
  toolRegistry: ToolRegistry,
  projectId: string | undefined,
): AgentConfig {
  return {
    provider: config.defaultProvider,
    model: config.defaultModel,
    tools: resolveEnabledToolNames(toolRegistry, config).filter(
      (n) => Boolean(projectId) || !PROJECT_BOUND_TOOLS.has(n),
    ),
    plugins: config.plugins.enabled,
    agentName: 'default',
  }
}
