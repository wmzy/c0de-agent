import { Hono } from 'hono'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/** GET/PUT /api/permissions — 授权模式（default 逐个确认 / auto 自动放行 ask 工具）。
 *  - 根路径：默认模式（全局，启动时取 config.permission.defaultMode）
 *  - /:sessionId：会话级覆盖（P1-5 按会话隔离 auto 高风险状态）
 */
function createPermissionsRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET / — 默认授权模式
  app.get('/', (c) => {
    return c.json({ mode: ctx.permissionMode })
  })

  // PUT / — 运行时切换默认模式（仅本次运行生效，不回写 config）
  app.put('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { mode?: unknown } | null
    const mode = body?.mode
    if (mode !== 'default' && mode !== 'auto') {
      return apiError(c, 400, 'INVALID_MODE', "mode 必须是 'default' 或 'auto'")
    }
    ctx.permissionMode = mode
    return c.json({ mode: ctx.permissionMode })
  })

  // GET /:sessionId — 会话实际生效模式（覆盖优先，回退默认）
  app.get('/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId')
    return c.json({ mode: ctx.sessionPermissionModes.get(sessionId) ?? ctx.permissionMode })
  })

  // PUT /:sessionId — 设置会话级覆盖；不传 mode 则清除覆盖
  app.put('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const body = (await c.req.json().catch(() => null)) as { mode?: unknown } | null
    const mode = body?.mode
    if (mode !== undefined && mode !== 'default' && mode !== 'auto') {
      return apiError(c, 400, 'INVALID_MODE', "mode 必须是 'default' 或 'auto'")
    }
    if (mode === undefined) {
      ctx.sessionPermissionModes.delete(sessionId)
    } else {
      ctx.sessionPermissionModes.set(sessionId, mode)
    }
    return c.json({ mode: ctx.sessionPermissionModes.get(sessionId) ?? ctx.permissionMode })
  })

  return app
}

export { createPermissionsRoute }
