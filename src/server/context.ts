// src/server/context.ts

import { BUILTIN_AGENTS, createAgentRegistry } from '../core/agents/index.js'
import type { AgentRegistry } from '../core/agents/types.js'
import { DEFAULT_CONFIG, mergeConfig } from '../core/config.js'
import type { DB } from '../db/client.js'
import type { Registry } from '../llm/registry.js'
import { createHookRunner, createPluginRegistry } from '../plugins/index.js'
import type { Config } from '../shared/types/config.js'
import { createDefaultRegistry, createDefaultURLRegistry } from '../tools/index.js'
import type { ToolRegistry } from '../tools/types.js'
import { createUpdateScheduler } from '../update/index.js'
import { createAgentManager } from './agent-manager.js'
import { createPermissionStore } from './permission/store.js'
import { PTYManager } from './terminal/pty-manager.js'
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
  // 用 mergeConfig 合并 DEFAULT_CONFIG，兼容测试传入 Partial<Config>（历史 cast 用法）。
  const config = mergeConfig(opts.config ?? DEFAULT_CONFIG)
  const hookRunner = createHookRunner()
  // Agent 注册表：测试可注入；默认含 4 个内置 agent（general/coder/researcher/reviewer）。
  const agentRegistry =
    opts.agentRegistry ??
    (() => {
      const reg = createAgentRegistry()
      for (const def of BUILTIN_AGENTS) reg.register(def)
      return reg
    })()
  return {
    db: opts.db,
    config,
    toolRegistry: opts.toolRegistry ?? createDefaultRegistry(config),
    llmRegistry: opts.llmRegistry,
    urlRegistry: createDefaultURLRegistry(),
    hookRunner,
    pluginRegistry: createPluginRegistry(hookRunner),
    agentManager: createAgentManager(),
    permissionStore: createPermissionStore(),
    permissionMode: config.permission.defaultMode,
    agentRegistry,
    // 测试上下文：默认 scheduler 不启动（enabled=false 由调用方控制）。
    updateScheduler: createUpdateScheduler({
      checkFn: async () => ({
        hasUpdate: false,
        currentVersion: '0.0.0',
        latestVersion: '0.0.0',
      }),
    }),
    cwd: opts.cwd ?? process.cwd(),
    ptyManager: new PTYManager(),
    ...(opts.chatStream ? { chatStream: opts.chatStream } : {}),
  }
}

export type { CreateServerContextOptions }
export { createServerContext, DEFAULT_CONFIG }
