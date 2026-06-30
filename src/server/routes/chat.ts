import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createAgent, runAgent } from '../../core/agent.js'
import type { LoopDeps } from '../../core/loop.js'
import { createSlashRegistry, parseSlashInput } from '../../core/slash.js'
import { getProject } from '../../project/project.js'
import { getSession } from '../../session/session.js'
import { upsertFileSnapshot } from '../../session/snapshot.js'
import type { AgentConfig } from '../../shared/types/agent.js'
import type { MessageContent } from '../../shared/types/message.js'
import { autoAllowChecker } from '../../tools/permission.js'
import { listTools } from '../../tools/registry.js'
import { apiError } from '../middleware/error.js'
import { createInteractivePermissionChecker } from '../permission/interactive.js'
import type { ServerContext } from '../types.js'
import { safeResolve } from '../util/safe-path.js'

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

    // 提前解析 cwd（slash 拦截与 agent 路径都需使用）
    const cwd = await resolveAgentCwd(ctx, session)

    // 斜杠命令拦截
    const parsed = parseSlashInput(message)
    if (parsed) {
      const registry = createSlashRegistry()
      const cmd = registry.get(parsed.name)
      if (cmd) {
        const commandCtx = {
          cwd,
          config: ctx.config,
          // 内置斜杠命令（/clear、/fork、/config）仅需 db + config；
          // permission/toolRegistry/llmRegistry 不会触发，用 autoAllow 凑齐类型。
          deps: {
            db: ctx.db,
            config: ctx.config,
            cwd,
            permission: autoAllowChecker,
            toolRegistry: ctx.toolRegistry,
            llmRegistry: ctx.llmRegistry,
          },
        }
        return streamSSE(c, async (stream) => {
          try {
            const result = await cmd.execute(parsed.args, commandCtx)
            if (result._tag === 'error') {
              await stream.writeSSE({
                event: 'error',
                data: JSON.stringify({
                  _tag: 'error',
                  error: { _tag: 'unexpected', message: result.message },
                }),
              })
            } else {
              const text = result._tag === 'success' ? result.message : result.text
              await stream.writeSSE({
                event: 'text_delta',
                data: JSON.stringify({ _tag: 'text_delta', text }),
              })
            }
            await stream.writeSSE({ event: 'done', data: JSON.stringify({ _tag: 'done' }) })
          } catch (e) {
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({
                _tag: 'error',
                error: { _tag: 'unexpected', message: String(e) },
              }),
            })
          }
        })
      }
      // 未知斜杠命令：回退为正常消息发给 agent
    }

    // 构建多模态 user content：文本在前，images（dataURL base64）在后
    const userContent: MessageContent[] = [{ _tag: 'text', text: message }]
    const images = body.images as Array<{ mediaType: string; data: string }> | undefined
    if (images?.length) {
      for (const img of images) {
        userContent.push({ _tag: 'image', mediaType: img.mediaType, data: img.data })
      }
    }

    // @文件上下文：读取文件内容写入快照，后续 getSessionContext→injectSnapshots 自动注入。
    // 路径越界或读取失败静默跳过，不阻塞主对话流。
    const files = body.files as string[] | undefined
    if (files?.length) {
      for (const p of files) {
        const resolved = safeResolve(cwd, p)
        if (!resolved) continue
        try {
          const content = await readFile(resolved, 'utf-8')
          await upsertFileSnapshot(ctx.db, sessionId, p, content)
        } catch {
          // 文件读取失败静默跳过
        }
      }
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

      // cwd 已在斜杠拦截前解析，此处直接复用

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
        for await (const event of runAgent(state, userContent, deps)) {
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
