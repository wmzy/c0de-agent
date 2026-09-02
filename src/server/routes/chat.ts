import { readFile, stat } from 'node:fs/promises'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createAgent, runAgent } from '../../core/agent.js'
import type { LoopDeps } from '../../core/loop.js'
import { compactContext } from '../../core/loop.js'
import { createSlashRegistry, parseSlashInput } from '../../core/slash.js'
import { injectSteering } from '../../core/steering.js'
import { buildWorkflowNotice, containsWorkflow } from '../../core/workflow.js'
import { getProject } from '../../project/project.js'
import { getLLMSegments, getSession, updateSessionLastRun } from '../../session/session.js'
import { upsertFileSnapshot } from '../../session/snapshot.js'
import type { AgentConfig } from '../../shared/types/agent.js'
import type { MessageContent } from '../../shared/types/message.js'
import { resolveEnabledToolNames } from '../../tools/index.js'
import { autoAllowChecker } from '../../tools/permission.js'
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
          // 但 /workflow run 会走 executeWorkflow → buildWorkflowContext → runSubAgent，
          // 该路径需要 agentRegistry 来派生子 agent，因此必须注入。
          // permission/toolRegistry 用 autoAllow 凑齐类型（子命令不触发交互权限）。
          workflowRegistry: ctx.workflowRegistry,
          deps: {
            db: ctx.db,
            config: ctx.config,
            cwd,
            permission: autoAllowChecker,
            toolRegistry: ctx.toolRegistry,
            llmRegistry: ctx.llmRegistry,
            agentRegistry: ctx.agentRegistry,
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
            await stream.writeSSE({ event: 'done', data: JSON.stringify({ _tag: 'done' }) })
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
    // 快照记录文件 mtime——注入前比对磁盘，过期自动刷新（P1-5）。
    // 路径越界或读取失败静默跳过，不阻塞主对话流。
    const files = body.files as string[] | undefined
    if (files?.length) {
      for (const p of files) {
        const resolved = safeResolve(cwd, p)
        if (!resolved) continue
        try {
          // 先 stat 再 readFile（与 session/context.ts 刷新路径一致）：若先读后
          // stat，文件恰在两次调用间被写会存「旧内容 + 新 mtime」，注入前的
          // mtime 相等判定使旧内容被永久钉住；先 stat 后读最坏存「新内容 +
          // 旧 mtime」，下次注入仍会触发刷新，可自愈。
          const st = await stat(resolved)
          const content = await readFile(resolved, 'utf-8')
          await upsertFileSnapshot(ctx.db, sessionId, p, content, st.mtimeMs)
        } catch {
          // 文件读取失败静默跳过
        }
      }
    }

    const provider = (body.provider as string) ?? ctx.config.defaultProvider
    const model = (body.model as string) ?? ctx.config.defaultModel
    // 并发守卫（P0-4）：同步原子占位 tryAcquire（Map has+set 一气呵成、无 await）。
    // 旧实现先 get 检查、真正 register 在 SSE 回调内，两者之间隔多个 await
    // （getLLMSegments、createAgent 等）：双发 POST 在窗口内均通过守卫，后注册
    // 覆盖前者（agentManager runs.set），且 A 结束时 unregister 把仍在跑的 B
    // 删掉，abort/steer/pause 对 B 全部失效。占位失败说明该会话已被占用
    // （活跃 run 或另一请求的占位），立即 409。
    if (!ctx.agentManager.tryAcquire(sessionId)) {
      return apiError(c, 409, 'RUN_ACTIVE', '该会话已有进行中的对话')
    }
    // 占位持有期（tryAcquire → SSE 回调 register）内的任何提前返回或抛错都必须
    // 释放占位，否则该会话被永久 409 锁死。handedOff 标记所有权已移交 SSE 回调
    // （其 finally 负责幂等释放），移交前的全部路径在 finally 统一兜底释放。
    let handedOff = false
    try {
      // 工具解析（P1-1）：config.tools.enabled 非空时作为默认集；空 = 全部注册工具。
      // disabled 已在 registry 层过滤（createDefaultRegistry），此处兜底。
      const tools = resolveEnabledToolNames(
        ctx.toolRegistry,
        ctx.config,
        body.tools as string[] | undefined,
      )

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
      // 守卫 409 短路后 agentManager.get 恒为 undefined，原 existingRun 三元
      // 恒走 else 分支（死代码，已删除）。
      const segs = await getLLMSegments(ctx.db, sessionId)
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

      const response = streamSSE(c, async (stream) => {
        // P0-4：回调从首行起全部纳入 try/finally——createAgent、updateSessionLastRun
        // 等启动阶段失败同样必须释放占位并补发 error/done（hono 的 stream 包装器
        // 只 console.error 不善后），不得泄漏占位或让前端卡在 streaming 态。
        let doneSent = false
        let runStartedAt: number | undefined
        try {
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
          runStartedAt = Date.now()
          await updateSessionLastRun(ctx.db, sessionId, {
            status: 'running',
            ...(agentName !== 'default' ? { agentName } : {}),
            provider,
            model: resolvedModel,
            startedAt: runStartedAt,
          })

          // 填充 tryAcquire 留下的占位（原 register 语义：按 sessionId 覆盖写入）
          ctx.agentManager.register({ sessionId, state, deps })

          // workflowz 关键词检测：用户消息包含独立关键词时注入工作流通知（steering），
          // 引导模型用 task 工具批量 fan-out 做确定性多子 agent 分解。
          if (containsWorkflow(message)) {
            const wfList = ctx.workflowRegistry
              ? ctx.workflowRegistry.list().map((w) => ({
                  name: w.meta.name,
                  description: w.meta.description,
                }))
              : []
            injectSteering(state, buildWorkflowNotice(wfList))
          }

          // 客户端断开时中止 agent
          stream.onAbort(() => {
            ctx.agentManager.abort(sessionId)
          })

          // 跟踪 done 事件是否已发送：agentLoop 正常完成时 yield done；
          // 但 error/abort/max_turns 等路径不 yield done，需在 finally 补发。
          // 否则前端 isStreaming 永远不会变 false，按钮卡在「终止」态。
          try {
            for await (const event of runAgent(state, userContent, deps)) {
              if (event._tag === 'done') doneSent = true
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
          }
        } catch (err) {
          // 启动阶段（createAgent/updateSessionLastRun 等）失败：补发 error 事件。
          // 客户端已断开时 writeSSE 会 reject，吞掉以保证 finally 善后执行。
          await stream
            .writeSSE({
              event: 'error',
              data: JSON.stringify({
                _tag: 'error',
                error: {
                  _tag: 'unexpected',
                  message: err instanceof Error ? err.message : String(err),
                },
              }),
            })
            .catch(() => {})
        } finally {
          // 先从 agentManager 释放（占位与活跃 run 均幂等）：必须最先执行，确保
          // 客户端断开使 writeSSE reject 时 agent 状态（state/deps/AbortController）
          // 不会泄漏到 Map（unregister 仅做 Map.delete、不依赖 state，放最前安全）。
          ctx.agentManager.unregister(sessionId)
          // agentLoop 的 error/abort/max_turns 路径不 yield done，在此补发。
          // 正常完成路径已在循环中 yield done，doneSent=true 时跳过避免重复。
          // 客户端已断开时 writeSSE 会 reject，吞掉以保证后续 updateSessionLastRun 执行。
          if (!doneSent) {
            await stream
              .writeSSE({ event: 'done', data: JSON.stringify({ _tag: 'done' }) })
              .catch(() => {})
          }
          // 无论正常完成、错误还是 abort，只要服务还活着就标记 completed。
          // 只有服务崩溃/重启才会留下 status='running' → 下次加载检测为 interrupted。
          // runStartedAt 未定义说明 run 从未真正启动（createAgent 即失败），DB 中
          // 无 'running' 标记需要清理，跳过写入。
          if (runStartedAt !== undefined) {
            await updateSessionLastRun(ctx.db, sessionId, {
              status: 'completed',
              ...(agentName !== 'default' ? { agentName } : {}),
              provider,
              model: resolvedModel,
              startedAt: runStartedAt,
            }).catch(() => {})
          }
        }
      })
      // streamSSE 已同步启动回调（回调的 register/finally 从此接管占位填充与
      // 释放），所有权移交：本层 finally 不再兜底释放。
      handedOff = true
      return response
    } finally {
      if (!handedOff) ctx.agentManager.unregister(sessionId)
    }
  })

  // 控制端点
  // P0-4：占位中的会话（tryAcquire 后、register 前）run 尚无 state 可供
  // abort/pause/resume/steer 操作——返回明确 409 而非静默 false 或崩溃。
  const runStarting = (c: Context, sessionId: string): Response | undefined =>
    ctx.agentManager.isStarting(sessionId)
      ? apiError(c, 409, 'RUN_STARTING', '该会话的对话正在启动，请稍后重试')
      : undefined

  app.post('/abort', async (c) => {
    const { sessionId } = await c.req.json()
    return runStarting(c, sessionId) ?? c.json({ aborted: ctx.agentManager.abort(sessionId) })
  })

  app.post('/pause', async (c) => {
    const { sessionId } = await c.req.json()
    return runStarting(c, sessionId) ?? c.json({ paused: ctx.agentManager.pause(sessionId) })
  })

  app.post('/resume', async (c) => {
    const { sessionId } = await c.req.json()
    return runStarting(c, sessionId) ?? c.json({ resumed: ctx.agentManager.resume(sessionId) })
  })

  app.post('/steer', async (c) => {
    const body = await c.req.json()
    return (
      runStarting(c, body.sessionId) ??
      c.json({ steered: ctx.agentManager.steer(body.sessionId, body.message) })
    )
  })

  return app
}

export { createChatRoute }
