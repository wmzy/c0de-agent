import { Hono } from 'hono'
import type { ServerContext } from '../types.js'

function createAgentRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET / — 返回所有 agent（前端按 mode 过滤展示）
  app.get('/', (c) => {
    const all = ctx.agentRegistry.list()
    return c.json({
      agents: all.map((d) => ({
        name: d.name,
        description: d.description,
        mode: d.mode,
        source: d.source,
        hasTools: Boolean(d.tools),
      })),
    })
  })

  return app
}

export { createAgentRoute }
