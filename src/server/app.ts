// src/server/app.ts
import { existsSync } from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { errorHandler } from './middleware/error.js'
import { createChatRoute } from './routes/chat.js'
import { createConfigRoute } from './routes/config.js'
import { createFilesRoute } from './routes/files.js'
import { createHealthRoute } from './routes/health.js'
import { createProjectRoute } from './routes/project.js'
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
  app.route('/api/projects', createProjectRoute(ctx))
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
        '/api/projects',
        '/api/chat',
        '/api/tools',
        '/api/config',
        '/api/files',
      ],
    }),
  )

  // 静态文件服务（生产环境 dist-web/ 存在时启用）
  if (existsSync(path.resolve(ctx.cwd, 'dist-web'))) {
    app.use('/*', serveStatic({ root: './dist-web' }))
    app.get('/*', (c) => c.body(null)) // SPA fallback
  }

  return app
}

export { createApp }
