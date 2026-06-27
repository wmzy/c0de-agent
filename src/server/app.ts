// src/server/app.ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { errorHandler } from './middleware/error.js'
import { createChatRoute } from './routes/chat.js'
import { createConfigRoute } from './routes/config.js'
import { createFilesRoute } from './routes/files.js'
import { createHealthRoute } from './routes/health.js'
import { createSessionRoute } from './routes/session.js'
import { createToolRoute } from './routes/tool.js'
import type { ServerContext } from './types.js'

/** 创建完整的 Hono 应用，挂载所有路由 + 中间件。 */
function createApp(ctx: ServerContext): Hono {
  const app = new Hono()

  // 中间件
  app.onError(errorHandler)
  app.use('*', cors())

  // 路由
  app.route('/api/health', createHealthRoute())
  app.route('/api/sessions', createSessionRoute(ctx))
  app.route('/api/chat', createChatRoute(ctx))
  app.route('/api/tools', createToolRoute(ctx))
  app.route('/api/config', createConfigRoute(ctx))
  app.route('/api/files', createFilesRoute(ctx))

  // 根路径
  app.get('/', (c) =>
    c.json({
      name: 'c0de-agent',
      version: '0.1.0',
      endpoints: [
        '/api/health',
        '/api/sessions',
        '/api/chat',
        '/api/tools',
        '/api/config',
        '/api/files',
      ],
    }),
  )

  return app
}

export { createApp }
