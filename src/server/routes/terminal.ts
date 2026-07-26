// src/server/routes/terminal.ts

import { Hono } from 'hono'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/** 创建终端路由（REST 部分；WebSocket 升级在 server.ts 中处理）。 */
function createTerminalRoute(ctx: ServerContext): Hono {
  const app = new Hono()
  const mgr = ctx.ptyManager

  // 列出所有活跃 PTY
  app.get('/', (c) => {
    return c.json({ terminals: mgr.list() })
  })

  // 创建新 PTY 会话
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const cwd = typeof body.cwd === 'string' && body.cwd.length > 0 ? body.cwd : ctx.cwd
    const cols = Number.isFinite(body.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body.rows) ? Number(body.rows) : undefined
    const title = typeof body.title === 'string' ? body.title : undefined
    const shell = typeof body.shell === 'string' && body.shell.length > 0 ? body.shell : undefined
    const projectId =
      typeof body.projectId === 'string' && body.projectId.length > 0 ? body.projectId : undefined

    try {
      const info = mgr.create({ cwd, cols, rows, title, shell, projectId })
      return c.json(info, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create terminal'
      return apiError(c, 500, 'PTY_CREATE_FAILED', message)
    }
  })

  // 获取单个 PTY 信息
  app.get('/:id', (c) => {
    const info = mgr.get(c.req.param('id'))
    if (!info) return apiError(c, 404, 'PTY_NOT_FOUND', 'Terminal not found')
    return c.json(info)
  })

  // 调整尺寸 / 更新标题
  app.put('/:id', async (c) => {
    const id = c.req.param('id')
    const info = mgr.get(id)
    if (!info) return apiError(c, 404, 'PTY_NOT_FOUND', 'Terminal not found')

    const body = await c.req.json().catch(() => ({}))

    if (body.cols != null && body.rows != null) {
      const cols = Number(body.cols)
      const rows = Number(body.rows)
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
        return apiError(c, 400, 'INVALID_SIZE', 'cols and rows must be numbers')
      }
      mgr.resize(id, cols, rows)
    }

    if (typeof body.title === 'string') {
      mgr.setTitle(id, body.title)
    }

    return c.json(mgr.get(id))
  })

  // 终止 PTY
  app.delete('/:id', (c) => {
    const id = c.req.param('id')
    if (!mgr.get(id)) return apiError(c, 404, 'PTY_NOT_FOUND', 'Terminal not found')
    mgr.kill(id)
    return c.json({ ok: true })
  })

  return app
}

export { createTerminalRoute }
