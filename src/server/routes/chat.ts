import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createAgent, runAgent } from '../../core/agent.js'
import type { LoopDeps } from '../../core/loop.js'
import { getProject } from '../../project/project.js'
import { getSession } from '../../session/session.js'
import type { AgentConfig } from '../../shared/types/agent.js'
import { listTools } from '../../tools/registry.js'
import { apiError } from '../middleware/error.js'
import { createInteractivePermissionChecker } from '../permission/interactive.js'
import type { ServerContext } from '../types.js'

/** 按 session.projectId 解析 agent 工作目录；无项目回退 ctx.cwd。 */
export async function resolveAgentCwd(
  ctx: ServerContext,
  session: { projectId: string | null },
): Promise<string> {
  if (!session.projectId) return ctx.cwd
  const project = await getProject(ctx.db, session.projectId)
  return project?.worktree ?? ctx.cwd
}

function createChatRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // POST / — SSE 流式聊天
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const sessionId = body.sessionId as string | undefined
    const message = body.message as string | undefined

    if (!sessionId || !message) {
      return apiError(c, 400, 'BAD_REQUEST', 'sessionId and message are required')
    }

    let session: Awaited<ReturnType<typeof getSession>>
    try {
      session = await getSession(ctx.db, sessionId)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
    if (!session) {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }

    return streamSSE(c, async (stream) => {
      // 权限检查器：ask 权限通过 SSE 通知前端，阻塞等待确认
      const permissionChecker = createInteractivePermissionChecker(ctx.permissionStore, {
        onPermissionRequired: async (req) => {
          await stream.writeSSE({
            event: 'permission_required',
            data: JSON.stringify({ _tag: 'permission_required', ...req }),
          })
        },
      })

      const cwd = await resolveAgentCwd(ctx, session)

      // 构建 agent 依赖（注入测试用 chatStream）
      const deps: LoopDeps = {
        db: ctx.db,
        llmRegistry: ctx.llmRegistry,
        toolRegistry: ctx.toolRegistry,
        urlRegistry: ctx.urlRegistry,
        hookRunner: ctx.hookRunner,
        permission: permissionChecker,
        config: ctx.config,
        cwd,
        ...(ctx.chatStream ? { chatStream: ctx.chatStream } : {}),
      }

      const provider = (body.provider as string) ?? ctx.config.defaultProvider
      const model = (body.model as string) ?? ctx.config.defaultModel
      // 前端 ToolToggle 全选时不传 tools（undefined），语义为「启用全部注册工具」。
      // 显式传 [] 才是禁用全部。config.tools.enabled 仅 CLI 模式使用，此处不回退它，
      // 避免配置里 enabled:[] 把 Web 全选误降级为无工具（LLM 无法 function call）。
      const tools =
        (body.tools as string[] | undefined) ??
        listTools(ctx.toolRegistry, { config: {}, cwd }).map((t) => t.name)

      const agentConfig: AgentConfig = {
        provider,
        model,
        tools,
        plugins: ctx.config.plugins.enabled,
      }

      const state = await createAgent(session, agentConfig, deps)

      ctx.agentManager.register({ sessionId, state, deps })

      // 客户端断开时中止 agent
      stream.onAbort(() => {
        ctx.agentManager.abort(sessionId)
      })

      try {
        for await (const event of runAgent(state, message, deps)) {
          await stream.writeSSE({
            event: event._tag,
            data: JSON.stringify(event),
          })
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : typeof err === 'object' && err !== null && 'message' in err
              ? String((err as { message: unknown }).message)
              : String(err)
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            _tag: 'error',
            error: {
              _tag: 'unexpected',
              message,
            },
          }),
        })
      } finally {
        ctx.agentManager.unregister(sessionId)
      }
    })
  })

  // 控制端点
  app.post('/abort', async (c) => {
    const { sessionId } = await c.req.json()
    return c.json({ aborted: ctx.agentManager.abort(sessionId) })
  })

  app.post('/pause', async (c) => {
    const { sessionId } = await c.req.json()
    return c.json({ paused: ctx.agentManager.pause(sessionId) })
  })

  app.post('/resume', async (c) => {
    const { sessionId } = await c.req.json()
    return c.json({ resumed: ctx.agentManager.resume(sessionId) })
  })

  app.post('/steer', async (c) => {
    const body = await c.req.json()
    return c.json({ steered: ctx.agentManager.steer(body.sessionId, body.message) })
  })

  return app
}

export { createChatRoute }
