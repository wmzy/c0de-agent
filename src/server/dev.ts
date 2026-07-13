// src/server/dev.ts

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Hono } from 'hono'
import { createApp } from './app.js'
import { buildServerContext, createDevDb, releaseDevDbLock, resolveDbDir } from './server.js'
import type { ServerContext } from './types.js'

/**
 * 开发环境入口：初始化并返回 Hono app。
 * 供 vite dev server 中间件复用，使前后端共享同一端口。
 *
 * ## 全量重建（B 方案）
 *
 * 目标：编辑任意 server/core 代码后热重载，新代码对**新请求**全部生效——与进程重启同语义，
 * 只是不开新进程。
 *
 * 缓存策略分两层：
 *
 * 1. **PGLite DB handle** → globalThis（唯一跨重载存活物）。
 *    PGLite 是单写者 WASM DB，同一 dataDir 不能开第二个连接（WAL 冲突 / Aborted()），
 *    所以 db 必须跨重载复用。其余一切重建。
 *
 * 2. **ctx + app** → 模块级变量。
 *    Vite 重载本模块时归 null，下次请求触发 rebuild：
 *      dispose 旧 ctx（abort 活跃 run + settle pending permission + stop scheduler + close handoff）
 *      → 围绕复用的 db 调 buildServerContext（重建 agentManager/permissionStore/registries/plugins/app）
 *      → 全部用最新代码。
 *
 * ## 与热升级的关系
 *
 * 和 `performHotUpdate` 是同一原理，差只在 spawn 新进程 vs 进程内重建。两者都：
 *   - 保留 durable 状态（DB rows）
 *   - 丢弃非 durable 状态（in-flight 工具执行、pending Promise resolver、活跃 run 内存态）
 *   - 活跃 run 从最后持久化消息重启
 *
 * 活跃 run 被 abort 后，loop 在 turn/流边界检测 signal → unwind → 调用方 finally 持久化
 * 状态（标记 interrupted/completed）。前端再发消息时从 DB 历史起新 run，全用新代码。
 */
const DEV_DB_KEY = '__c0de_dev_db__'

/** 模块级：随本模块重载而重置。 */
let ctx: ServerContext | null = null
let app: Hono | null = null
let disposeCtx: (() => Promise<void>) | null = null

async function rebuild(): Promise<void> {
  // 1. dispose 旧 ctx（不 close db）
  if (disposeCtx) {
    await disposeCtx()
    disposeCtx = null
    ctx = null
    app = null
  }

  // 2. 取/建 devDb（globalThis，PGLite 单写者，只建一次）
  const g = globalThis as Record<string, unknown>
  if (!g[DEV_DB_KEY]) {
    g[DEV_DB_KEY] = await createDevDb(process.cwd())
  }
  const db = g[DEV_DB_KEY] as ServerContext['db']

  // 3. 围绕复用的 db 重建 ctx（skipHandoff：dev 不跑热升级 handoff）
  const built = await buildServerContext(db, { cwd: process.cwd(), skipHandoff: true })
  ctx = built.ctx
  disposeCtx = built.dispose
  app = createApp(ctx)
}

async function getDevApp(): Promise<Hono> {
  if (app) return app
  await rebuild()
  if (!app) throw new Error('dev app failed to initialize')
  return app
}

/** 获取当前 dev ctx（WebSocket 升级等需要直接访问 ptyManager 的场景）。 */
async function getDevCtx(): Promise<ServerContext> {
  if (!ctx) await getDevApp()
  if (!ctx) throw new Error('dev ctx not initialized')
  return ctx
}

/** vite dev server 关闭时调用，确保 PGLite WASM 正常 close 并刷写 WAL。 */
async function closeDevApp(): Promise<void> {
  if (disposeCtx) {
    await disposeCtx()
    disposeCtx = null
    ctx = null
    app = null
  }
  const g = globalThis as Record<string, unknown>
  const db = g[DEV_DB_KEY] as ServerContext['db'] | undefined
  if (db) {
    await db.close()
    delete g[DEV_DB_KEY]
  }
  // Release cross-process lock so the next dev server can start cleanly.
  releaseDevDbLock(resolveDbDir())
}

/**
 * 把 Node 请求桥接到 Hono app 并流式回写响应（支持 SSE）。
 * 用 Readable.fromWeb 管道转发 Response body，原生处理背压与分块。
 */
async function handleApiRequest(
  app: Hono,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const host = (req.headers.host as string | undefined) ?? 'localhost'
  const url = new URL(req.url ?? '/', `http://${host}`)

  let body: Buffer | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    body = Buffer.concat(chunks)
  }

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers.set(key, value)
    } else if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    }
  }

  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers,
  }
  if (body !== undefined) {
    init.body = body
    init.duplex = 'half'
  }

  const request = new Request(url.toString(), init)
  const response = await app.fetch(request)

  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })

  const responseBody = response.body
  if (responseBody) {
    // Readable.fromWeb 需要 web stream；Hono Response.body 已是 ReadableStream。
    // native pipeline handles backpressure + chunked encoding for SSE.
    Readable.fromWeb(responseBody as unknown as Parameters<typeof Readable.fromWeb>[0])
      .pipe(res)
      .on('error', (err) => {
        if (!res.headersSent) res.statusCode = 500
        res.end()
        console.error('[c0de-hono-api] response stream error:', err)
      })
  } else {
    res.end()
  }
}

export { closeDevApp, getDevApp, getDevCtx, handleApiRequest }
