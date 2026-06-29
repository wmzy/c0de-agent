// src/server/context.ts
import { DEFAULT_CONFIG } from '../core/config.js'
import type { DB } from '../db/client.js'
import type { Registry } from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'
import { createDefaultRegistry } from '../tools/index.js'
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
}

function createServerContext(opts: CreateServerContextOptions): ServerContext {
  return {
    db: opts.db,
    config: opts.config ?? DEFAULT_CONFIG,
    toolRegistry: opts.toolRegistry ?? createDefaultRegistry(),
    llmRegistry: opts.llmRegistry,
    agentManager: createAgentManager(),
    permissionStore: createPermissionStore(),
    cwd: opts.cwd ?? process.cwd(),
    ...(opts.chatStream ? { chatStream: opts.chatStream } : {}),
  }
}

export type { CreateServerContextOptions }
export { createServerContext }
