// src/server/server.ts

import type { Server as NodeServer } from 'node:http'
import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import { loadConfig } from '../core/config.js'
import type { DB } from '../db/client.js'
import { createDB, migrateDB } from '../db/index.js'
import type { Registry } from '../llm/registry.js'
import { createRegistry, registerProvider } from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'
import type { ProviderConfig } from '../shared/types/llm.js'
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

type BootstrappedServer = {
  ctx: ServerContext
  close(): Promise<void>
}

/** 把 config.providers 注册到新建的 LLM registry（修复此前空 registry 的遗漏）。 */
function buildRegistryFromConfig(config: Config): Registry {
  const registry = createRegistry()
  for (const p of config.providers) {
    registerProviderFromConfig(registry, p)
  }
  return registry
}

function registerProviderFromConfig(registry: Registry, p: ProviderConfig): void {
  // 兼容 config.json 中以 _tag 标识 provider 的格式（name 缺失时回退到 _tag）
  const name = p.name || (p as { _tag?: string })._tag
  if (!name || !p.baseURL) return
  // baseURL 已含 /v1 时用 /chat/completions，避免 /v1/v1 双重前缀
  const path = p.baseURL.replace(/\/+$/, '').endsWith('/v1') ? '/chat/completions' : undefined
  registerProvider(registry, {
    name,
    baseURL: p.baseURL,
    apiKey: p.apiKey,
    ...(path ? { path } : {}),
  })
}

/** 初始化 DB + 配置 + 注册表，返回 ServerContext + 清理函数（dev 与独立后端共用）。 */
async function bootstrapServerContext(opts: StartServerOptions = {}): Promise<BootstrappedServer> {
  const cwd = opts.cwd ?? process.cwd()

  const ownsDb = !opts.db
  const db = opts.db ?? (await createDB({ driver: 'pglite' }))
  await migrateDB(db)

  const config = await loadConfig(cwd)
  const toolRegistry = createDefaultRegistry()
  const llmRegistry = buildRegistryFromConfig(config)

  const ctx: ServerContext = {
    db,
    config,
    toolRegistry,
    llmRegistry,
    agentManager: createAgentManager(),
    cwd,
  }

  return {
    ctx,
    close: async () => {
      if (ownsDb) await db.close()
    },
  }
}

/** 启动完整服务：初始化 DB + 配置 + 注册表 + Hono 应用 + HTTP 服务器。 */
async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const port = opts.port ?? 3000
  const { ctx, close: closeCtx } = await bootstrapServerContext(opts)
  const app = createApp(ctx)

  const server = serve({ fetch: app.fetch, port }) as unknown as NodeServer

  return {
    app,
    port,
    close: () => {
      server.close()
      void closeCtx()
    },
  }
}

export type { BootstrappedServer, RunningServer, StartServerOptions }
export { bootstrapServerContext, buildRegistryFromConfig, startServer }
