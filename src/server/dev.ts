// src/server/dev.ts

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Hono } from 'hono'
import { createApp } from './app.js'
import { bootstrapServerContext } from './server.js'

/**
 * 开发环境入口：初始化并返回 Hono app。
 * 供 vite dev server 中间件复用，使前后端共享同一端口。
 *
 * 用 globalThis 缓存而非模块级变量：Vite ssrLoadModule 在 server 端代码变更时会
 * 重新执行本模块，模块级 cachedApp 会重置；这会导致运行中的 AgentManager（含
 * 权限确认 pending）丢失，前端 POST /api/tools/confirm 拿不到 pending 而 404。
 * globalThis 跨模块重载保持单例，避免权限流程中途断裂。
 */
const DEV_APP_KEY = '__c0de_dev_app__'
const DEV_CLOSE_KEY = '__c0de_dev_close__'

async function getDevApp(): Promise<Hono> {
  const g = globalThis as Record<string, unknown>
  if (!g[DEV_APP_KEY]) {
    const { ctx, close } = await bootstrapServerContext({ cwd: process.cwd() })
    g[DEV_APP_KEY] = createApp(ctx)
    g[DEV_CLOSE_KEY] = close
  }
  return g[DEV_APP_KEY] as Hono
}

/** vite dev server 关闭时调用，确保 PGLite WASM 正常 close 并刷写 WAL。 */
async function closeDevApp(): Promise<void> {
  const g = globalThis as Record<string, unknown>
  const close = g[DEV_CLOSE_KEY] as (() => Promise<void>) | undefined
  if (close) {
    await close()
    delete g[DEV_APP_KEY]
    delete g[DEV_CLOSE_KEY]
  }
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
    if (value != null) {
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
  }

  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers,
    body: body ?? undefined,
  }
  if (body !== undefined) {
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
    res.flushHeaders()
    await new Promise<void>((resolve, reject) => {
      const nodeStream = Readable.fromWeb(responseBody)
      nodeStream.on('error', reject)
      nodeStream.pipe(res).on('finish', resolve)
    })
  } else {
    res.end()
  }
}

export { closeDevApp, getDevApp, handleApiRequest }
