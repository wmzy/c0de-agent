import { Hono } from 'hono'
import { mergeConfig, saveConfig } from '../../core/config.js'
import { syncRegistryFromConfig } from '../server.js'
import type { ServerContext } from '../types.js'

function createConfigRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    return c.json(ctx.config)
  })

  app.patch('/', async (c) => {
    const patch = await c.req.json()
    ctx.config = mergeConfig(ctx.config, patch as Record<string, unknown>)
    // providers 变更后原地同步 registry，使运行中的连接立即生效
    syncRegistryFromConfig(ctx.llmRegistry, ctx.config)
    await saveConfig(ctx.config, 'project', ctx.cwd).catch(() => {
      // 保存失败不影响内存配置
    })
    return c.json(ctx.config)
  })

  return app
}

export { createConfigRoute }
