import { Hono } from 'hono'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/** GET/PUT /api/permissions — 全局授权模式（default 逐个确认 / auto 自动放行 ask 工具）。 */
function createPermissionsRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET / — 当前授权模式
  app.get('/', (c) => {
    return c.json({ mode: ctx.permissionMode })
  })

  // PUT / — 运行时切换授权模式（不持久化，重启回 default）
  app.put('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { mode?: unknown } | null
    const mode = body?.mode
    if (mode !== 'default' && mode !== 'auto') {
      return apiError(c, 400, 'INVALID_MODE', "mode 必须是 'default' 或 'auto'")
    }
    ctx.permissionMode = mode
    return c.json({ mode: ctx.permissionMode })
  })

  return app
}

export { createPermissionsRoute }
