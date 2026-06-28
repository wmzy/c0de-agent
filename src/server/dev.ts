// src/server/dev.ts

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Hono } from 'hono'
import { createApp } from './app.js'
import { bootstrapServerContext } from './server.js'

let cachedApp: Hono | undefined

/**
 * 开发环境入口：初始化并返回 Hono app。
 * 供 vite dev server 中间件复用，使前后端共享同一端口。
 * 首次调用完成 DB/配置/注册表初始化，后续直接返回缓存的 app。
 */
async function getDevApp(): Promise<Hono> {
  if (!cachedApp) {
    const { ctx } = await bootstrapServerContext({ cwd: process.cwd() })
    cachedApp = createApp(ctx)
  }
  return cachedApp
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

export { getDevApp, handleApiRequest }
