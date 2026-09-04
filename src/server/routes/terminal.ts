// src/server/routes/terminal.ts

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Hono } from 'hono'
import { getProject } from '../../project/index.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/** 允许的 shell 白名单（P2-6：拒绝路径分隔符与任意二进制）。 */
const ALLOWED_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh'])

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
    const projectId =
      typeof body.projectId === 'string' && body.projectId.length > 0 ? body.projectId : undefined

    // P2-13：未显式传 cwd 且带 projectId 时，默认目录跟随项目 worktree
    // （与 chat 的 resolveAgentCwd 行为一致；项目缺失/目录失效时回退 ctx.cwd）。
    let defaultCwd = ctx.cwd
    if (!(typeof body.cwd === 'string' && body.cwd.length > 0) && projectId) {
      try {
        const project = await getProject(ctx.db, projectId)
        if (project && existsSync(project.worktree)) defaultCwd = project.worktree
      } catch {
        // db 不可用（测试桩/临时故障）：保持 ctx.cwd
      }
    }
    const cwd = typeof body.cwd === 'string' && body.cwd.length > 0 ? body.cwd : defaultCwd
    const cols = Number.isFinite(body.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body.rows) ? Number(body.rows) : undefined
    const title = typeof body.title === 'string' ? body.title : undefined
    const shell = typeof body.shell === 'string' && body.shell.length > 0 ? body.shell : undefined

    // 入参校验（P2-6）：shell 白名单；cwd 必须为绝对路径。
    if (shell !== undefined) {
      if (shell.includes('/') || shell.includes('\\') || !ALLOWED_SHELLS.has(shell)) {
        return apiError(
          c,
          400,
          'INVALID_SHELL',
          `shell 必须是 ${[...ALLOWED_SHELLS].join('/')} 之一`,
        )
      }
    }
    if (typeof cwd === 'string' && cwd.length > 0 && !isAbsolute(cwd)) {
      return apiError(c, 400, 'INVALID_CWD', 'cwd 必须是绝对路径')
    }

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
