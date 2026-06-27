// src/server/server.ts

import type { Server as NodeServer } from 'node:http'
import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import { loadConfig } from '../core/config.js'
import type { DB } from '../db/client.js'
import { createDB, migrateDB } from '../db/index.js'
import { createRegistry } from '../llm/registry.js'
import { createDefaultRegistry } from '../tools/index.js'
import { createAgentManager } from './agent-manager.js'
import { createApp } from './app.js'
import type { ServerContext } from './types.js'

type StartServerOptions = {
  port?: number
  cwd?: string
  /** 注入已有 DB（测试用）。 */
  db?: DB
}

type RunningServer = {
  app: Hono
  port: number
  close(): void
}

/** 启动完整服务：初始化 DB + 配置 + 注册表 + Hono 应用 + HTTP 服务器。 */
async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const cwd = opts.cwd ?? process.cwd()

  const db = opts.db ?? (await createDB({ driver: 'pglite' }))
  await migrateDB(db)

  const config = await loadConfig(cwd)
  const toolRegistry = createDefaultRegistry()
  const llmRegistry = createRegistry()

  const ctx: ServerContext = {
    db,
    config,
    toolRegistry,
    llmRegistry,
    agentManager: createAgentManager(),
    cwd,
  }

  const app = createApp(ctx)
  const port = opts.port ?? 3000

  const server = serve({ fetch: app.fetch, port }) as unknown as NodeServer

  return {
    app,
    port,
    close: () => {
      server.close()
    },
  }
}

export type { RunningServer, StartServerOptions }
export { startServer }
