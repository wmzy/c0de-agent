// src/server/app.ts
import { existsSync } from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { createAuthMiddleware } from './middleware/auth.js'
import { createCORSMiddleware } from './middleware/cors.js'
import { errorHandler } from './middleware/error.js'
import { createAgentRoute } from './routes/agent.js'
import { createCatalogRoute } from './routes/catalog.js'
import { createChatRoute } from './routes/chat.js'
import { createCommandsRoute } from './routes/commands.js'
import { createConfigRoute } from './routes/config.js'
import { createFilesRoute } from './routes/files.js'
import { createFilesystemRoute } from './routes/filesystem.js'
import { createHealthRoute } from './routes/health.js'
import { createPermissionsRoute } from './routes/permissions.js'
import { createProjectRoute } from './routes/project.js'
import { createProviderRoute } from './routes/provider.js'
import { createSessionRoute } from './routes/session.js'
import { createTerminalRoute } from './routes/terminal.js'
import { createToolRoute } from './routes/tool.js'
import { createUpdateRoute } from './routes/update.js'
import { createWorkflowsRoute } from './routes/workflows.js'
import type { ServerContext } from './types.js'

/** 创建完整的 Hono 应用，挂载所有路由 + 中间件。 */
function createApp(ctx: ServerContext): Hono {
  const app = new Hono()

  // 中间件
  app.onError(errorHandler)
  // spec §24.2：仅允许本地/可信 origin 跨域读，拒绝外部网页。
  app.use('*', createCORSMiddleware({ allowedOrigins: ctx.config.security.allowedOrigins }))
  // spec §24.2：Bearer token 认证（配置了 token 时生效；/api/health 探活放行）。
  app.use(
    '/api/*',
    createAuthMiddleware(ctx.config.security.authEnabled ? ctx.config.security.token : undefined),
  )

  // 路由
  app.route('/api/health', createHealthRoute())
  app.route('/api/agents', createAgentRoute(ctx))
  app.route('/api/sessions', createSessionRoute(ctx))
  app.route('/api/projects', createProjectRoute(ctx))
  app.route('/api/providers', createProviderRoute(ctx))
  app.route('/api/catalog', createCatalogRoute(ctx))
  app.route('/api/filesystem', createFilesystemRoute(ctx))
  app.route('/api/chat', createChatRoute(ctx))
  app.route('/api/commands', createCommandsRoute(ctx))
  app.route('/api/tools', createToolRoute(ctx))
  app.route('/api/update', createUpdateRoute(ctx))
  app.route('/api/config', createConfigRoute(ctx))
  app.route('/api/permissions', createPermissionsRoute(ctx))
  app.route('/api/files', createFilesRoute(ctx))
  app.route('/api/terminal', createTerminalRoute(ctx))
  app.route('/api/workflows', createWorkflowsRoute(ctx))

  // 根路径
  app.get('/', (c) =>
    c.json({
      name: 'c0de-agent',
      version: '0.1.0',
      endpoints: [
        '/api/health',
        '/api/agents',
        '/api/sessions',
        '/api/projects',
        '/api/providers',
        '/api/catalog',
        '/api/filesystem',
        '/api/chat',
        '/api/commands',
        '/api/tools',
        '/api/update',
        '/api/config',
        '/api/permissions',
        '/api/files',
        '/api/terminal',
        '/api/workflows',
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
