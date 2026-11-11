import { Hono } from 'hono'
import { getProject } from '../../project/project.js'
import { resolveEnabledToolNames } from '../../tools/index.js'
import { listTools } from '../../tools/registry.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'
import { readJsonObject } from '../util/json-body.js'
import { resolveSessionScope } from '../util/session-scope.js'

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
      // 会话作用域解析收敛的第六处（chat/workflows/session/provider/files 之外）：
      // 与旧内联等价——cwd === serve cwd 时基线 ctx.config 已含该目录项目作用域，
      // mergeConfig 为覆盖式合并，重复合并同值幂等。不传 registryKey（本路由
      // 不消费注册表，也不会触发副作用构建）。
      config = resolveSessionScope(ctx, { cwd: project.worktree }).config
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
    // 畸形 JSON / null / 非对象 body → 400（readJsonObject 统一口径）。
    // 此前裸 await c.req.json()：畸形 JSON 击穿 Hono 500，null body 在
    // body.toolCallId 处 TypeError 500。
    const parsed = await readJsonObject(c)
    if (!parsed.ok) return parsed.response
    const { body } = parsed
    if (typeof body.toolCallId !== 'string' || body.toolCallId.length === 0) {
      return apiError(c, 400, 'BAD_REQUEST', 'toolCallId is required')
    }
    // 仅显式 true 放行：非布尔（"false" 字符串等 truthy 垃圾）按拒绝处理——
    // 绝不让客户端序列化缺陷把「拒绝」翻成「放行」。
    const ok = ctx.permissionStore.resolve(body.toolCallId, body.approved === true)
    if (!ok) {
      return apiError(c, 404, 'NOT_FOUND', 'No pending permission for this tool call')
    }
    return c.json({ confirmed: true })
  })

  return app
}

export { createToolRoute }
