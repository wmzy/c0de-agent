// src/server/context.ts
import { DEFAULT_CONFIG } from '../core/config.js'
import { BUILTIN_AGENTS, createAgentRegistry } from '../core/agents/index.js'
import type { AgentRegistry } from '../core/agents/types.js'
import type { DB } from '../db/client.js'
import type { Registry } from '../llm/registry.js'
import { createHookRunner, createPluginRegistry } from '../plugins/index.js'
import type { Config } from '../shared/types/config.js'
import { createDefaultRegistry, createDefaultURLRegistry } from '../tools/index.js'
import type { ToolRegistry } from '../tools/types.js'
import { createAgentManager } from './agent-manager.js'
import { createPermissionStore } from './permission/store.js'
import type { ServerContext } from './types.js'

type CreateServerContextOptions = {
  db: DB
  config?: Config
  toolRegistry?: ToolRegistry
  llmRegistry: Registry
  cwd?: string
  chatStream?: ServerContext['chatStream']
  /** 测试注入：覆盖默认（内置 agent）注册表。 */
  agentRegistry?: AgentRegistry
}

function createServerContext(opts: CreateServerContextOptions): ServerContext {
  // 测试/dev 工厂：补足 urlRegistry + hookRunner + pluginRegistry（空壳，不激活插件），
  // 生产启动走 bootstrapServerContext → initPlugins（激活 builtin + 发现外部插件）。
  const hookRunner = createHookRunner()
  // Agent 注册表：测试可注入；默认含 4 个内置 agent（general/coder/researcher/reviewer）。
  const agentRegistry = opts.agentRegistry ?? (() => {
    const reg = createAgentRegistry()
    for (const def of BUILTIN_AGENTS) reg.register(def)
    return reg
  })()
  return {
    db: opts.db,
    config: opts.config ?? DEFAULT_CONFIG,
    toolRegistry: opts.toolRegistry ?? createDefaultRegistry(opts.config ?? DEFAULT_CONFIG),
    llmRegistry: opts.llmRegistry,
    urlRegistry: createDefaultURLRegistry(),
    hookRunner,
    pluginRegistry: createPluginRegistry(hookRunner),
    agentManager: createAgentManager(),
    permissionStore: createPermissionStore(),
    permissionMode: 'default',
    agentRegistry,
    cwd: opts.cwd ?? process.cwd(),
    ...(opts.chatStream ? { chatStream: opts.chatStream } : {}),
  }
}

export type { CreateServerContextOptions }
export { createServerContext }
