import { Hono } from 'hono'
import { loadConfigScopes, mergeConfig } from '../../core/config.js'
import { getProject } from '../../project/project.js'
import { resolveEnabledToolNames } from '../../tools/index.js'
import { listTools } from '../../tools/registry.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

function createToolRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 列出可用工具（不含 execute 函数）。
  // P2 交集语义配套：列表按 config.tools.enabled 过滤——设置页禁用某工具后，
  // 输入区工具开关不再提供该工具，避免「勾选了却被服务端静默丢弃」的脱节。
  // ?projectId= 时按该项目合并配置过滤（与 chat 路由的工具解析同口径）。
  app.get('/', async (c) => {
    let config = ctx.config
    const projectId = c.req.query('projectId')
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) return apiError(c, 404, 'PROJECT_NOT_FOUND', '项目不存在')
      const projectScope = loadConfigScopes(project.worktree).project
      if (projectScope) config = mergeConfig(ctx.config, projectScope)
    }
    const enabledNames = resolveEnabledToolNames(ctx.toolRegistry, config)
    const enabledSet = new Set(enabledNames)
    const tools = listTools(ctx.toolRegistry, { config: {}, cwd: ctx.cwd })
      .filter((t) => enabledSet.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        permission: t.permission,
      }))
    return c.json(tools)
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
