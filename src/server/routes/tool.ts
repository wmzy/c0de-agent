import { Hono } from 'hono'
import { listTools } from '../../tools/registry.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

function createToolRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 列出可用工具（不含 execute 函数）
  app.get('/', (c) => {
    const tools = listTools(ctx.toolRegistry, { config: {}, cwd: ctx.cwd })
    const serializable = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      permission: t.permission,
    }))
    return c.json(serializable)
  })

  // 确认工具执行权限
  app.post('/confirm', async (c) => {
    const body = await c.req.json()
    const ok = ctx.permissionStore.resolve(body.toolCallId, body.approved)
    if (!ok) {
      return apiError(c, 404, 'NOT_FOUND', 'No pending permission for this tool call')
    }
    return c.json({ confirmed: true })
  })

  return app
}

export { createToolRoute }
