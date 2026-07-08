import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createAgent, runAgent } from '../../core/agent.js'
import type { LoopDeps } from '../../core/loop.js'
import { compactContext } from '../../core/loop.js'
import { createSlashRegistry, parseSlashInput } from '../../core/slash.js'
import { getProject } from '../../project/project.js'
import { getLLMSegments, getSession, updateSessionLastRun } from '../../session/session.js'
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
            if (result._tag === 'compact') {
              // /compact：手动触发上下文压缩。复用 loop.compactContext（createSummarizer +
              // runCompaction），不创建主 agent、不进入 LLM turn 循环（不把 /compact 当作
              // user 消息发给模型）。
              const provider = (body.provider as string) ?? ctx.config.defaultProvider
              const model = (body.model as string) ?? ctx.config.defaultModel
              const agentConfig: AgentConfig = {
                provider,
                model,
                tools: [],
                plugins: ctx.config.plugins.enabled,
                agentName: 'default',
              }
              const compactState = await createAgent(session, agentConfig, commandCtx.deps)
              try {
                for await (const event of compactContext(compactState, commandCtx.deps)) {
                  await stream.writeSSE({
                    event: event._tag,
                    data: JSON.stringify(event),
                  })
                }
              } catch (e) {
                await stream.writeSSE({
                  event: 'error',
                  data: JSON.stringify({
                    _tag: 'error',
                    error: {
                      _tag: 'unexpected',
                      message: e instanceof Error ? e.message : String(e),
                    },
                  }),
                })
              }
            } else if (result._tag === 'error') {
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

    // @agent 调用 subagent：在消息前注入指令（复用 task 工具派生）
    const mentionedAgents = (body.agents as string[]) ?? []
    if (mentionedAgents.length > 0) {
      const valid = mentionedAgents
        .map((n) => ctx.agentRegistry.get(n))
        .filter((d): d is NonNullable<typeof d> => Boolean(d && d.mode !== 'primary'))
      if (valid.length > 0) {
        const names = valid.map((d) => d.name).join(', ')
        const first = userContent[0]
        if (first && first._tag === 'text') {
          first.text = `[User requested subagent(s): ${names}]\n\n${first.text}`
        }
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

    const provider = (body.provider as string) ?? ctx.config.defaultProvider
    const model = (body.model as string) ?? ctx.config.defaultModel
    // 前端 ToolToggle 全选时不传 tools（undefined），语义为「启用全部注册工具」。
    // 显式传 [] 才是禁用全部。config.tools.enabled 仅 CLI 模式使用，此处不回退它，
    // 避免配置里 enabled:[] 把 Web 全选误降级为无工具（LLM 无法 function call）。
    const tools =
      (body.tools as string[] | undefined) ??
      listTools(ctx.toolRegistry, { config: {}, cwd }).map((t) => t.name)

    // primary agent 解析（spec: agent-frontend-switching §4.3）
    const agentName = (body.agent as string) ?? 'default'
    const agentDef = ctx.agentRegistry.get(agentName)
    if (!agentDef || agentDef.mode === 'subagent') {
      return apiError(c, 400, 'INVALID_AGENT', `Unknown or non-primary agent: ${agentName}`)
    }
    // agent def 覆盖：tools（plan 限只读）、model（可选）
    const resolvedTools = agentDef.tools ?? tools
    const resolvedModel = agentDef.model ?? model

    // 分段预检：切换 provider/model/tools 将开新段（前缀失效→缓存 miss），
    // 需用户显式确认（confirmSegmentBreak）。首轮无活跃段时跳过。
    const existingRun = ctx.agentManager.get(sessionId)
    const segs = existingRun ? existingRun.state.segments : await getLLMSegments(ctx.db, sessionId)
    const active = segs[segs.length - 1]
    if (active) {
      const reqTools = new Set(resolvedTools)
      const segTools = new Set(active.tools.map((t) => t.name))
      const toolsDiffer =
        reqTools.size !== segTools.size || [...reqTools].some((t) => !segTools.has(t))
      const modelDiffer = active.provider !== provider || active.model !== resolvedModel
      // 旧段 agentName undefined 视为 'default'
      const agentDiffer = (active.agentName ?? 'default') !== agentName
      const confirmed = (body.confirmSegmentBreak as boolean | undefined) === true
      if ((modelDiffer || toolsDiffer || agentDiffer) && !confirmed) {
        return apiError(
          c,
          409,
          'SEGMENT_BREAK_REQUIRED',
          '切换模型/工具将开始新的上下文段（缓存失效），需用户确认',
          {
            activeSegment: {
              provider: active.provider,
              model: active.model,
              tools: active.tools.map((t) => t.name),
            },
          },
        )
      }
    }

    return streamSSE(c, async (stream) => {
      // 权限检查器：ask 权限通过 SSE 通知前端，阻塞等待确认
      const permissionChecker = createInteractivePermissionChecker(ctx.permissionStore, {
        getMode: () => ctx.permissionMode,
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
        agentRegistry: ctx.agentRegistry,
        cwd,
        ...(ctx.chatStream ? { chatStream: ctx.chatStream } : {}),
      }

      const agentConfig: AgentConfig = {
        provider,
        model: resolvedModel,
        tools: resolvedTools,
        plugins: ctx.config.plugins.enabled,
        agentName,
        ...(agentDef.systemPrompt ? { agentRolePrompt: agentDef.systemPrompt } : {}),
      }

      const state = await createAgent(session, agentConfig, deps)

      // 持久化 run 状态：status='running' 写入 DB。服务重启后此字段仍为 'running'
      // 而进程无活跃 run → 检测为 interrupted。finally 中标记 'completed'。
      const runStartedAt = Date.now()
      await updateSessionLastRun(ctx.db, sessionId, {
        status: 'running',
        ...(agentName !== 'default' ? { agentName } : {}),
        provider,
        model: resolvedModel,
        startedAt: runStartedAt,
      })

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
        // 无论正常完成、错误还是 abort，只要服务还活着就标记 completed。
        // 只有服务崩溃/重启才会留下 status='running' → 下次加载检测为 interrupted。
        await updateSessionLastRun(ctx.db, sessionId, {
          status: 'completed',
          ...(agentName !== 'default' ? { agentName } : {}),
          provider,
          model: resolvedModel,
          startedAt: runStartedAt,
        }).catch(() => {})
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
