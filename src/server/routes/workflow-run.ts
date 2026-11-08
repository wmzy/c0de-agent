import type { Context } from 'hono'
import { type SSEStreamingApi, streamSSE } from 'hono/streaming'
import { createAgent } from '../../core/agent.js'
import type { Config } from '../../core/config.js'
import type { LoopDeps } from '../../core/loop.js'
import { discoverSkills } from '../../core/skills.js'
import type { CommandResult } from '../../core/types.js'
import { executeWorkflow, workflowSessionTitle } from '../../core/workflows/index.js'
import type { WorkflowRegistry } from '../../core/workflows/registry.js'
import type { WorkflowEntry } from '../../core/workflows/types.js'
import { createDebugSpawn } from '../../dap/index.js'
import type { Registry } from '../../llm/registry.js'
import { createSession, updateSessionLastRun } from '../../session/session.js'
import { budgetGateEnabled } from '../../session/usage.js'
import type { AgentConfig } from '../../shared/types/agent.js'
import { PROJECT_BOUND_TOOLS, resolveEnabledToolNames } from '../../tools/index.js'
import { apiError } from '../middleware/error.js'
import {
  createStreamPermissionChecker,
  resolvePermissionTimeoutAction,
} from '../permission/stream-checker.js'
import type { ServerContext } from '../types.js'
import { emitSseError } from '../util/sse.js'
import { childRunBridge, startHeartbeat } from './chat.js'

/**
 * 工作流执行共享通道（斜杠 /workflow run 与 REST POST /api/workflows/:name/run 的
 * 单点实现）。此前两份 ~230 行完整复制已发生漂移（斜杠 deps 缺 skills/debugSpawn）。
 *
 * 本模块负责：busy-scope 并发守卫 + tryAcquire、工作流会话创建/占用标记、
 * lastRun 持久化、交互式权限 checker（超时/过期级联暂停）、LoopDeps 单点组装
 * （skills/debugSpawn 只在此注入一次）、createAgent/register/stream.onAbort(abort)、
 * executeWorkflow、进度与终态事件发射、finally 清理（unregister/completed/释放占用）。
 *
 * 各通道保留的部分（调用方实现）：入口校验、entry 解析（信任门禁口径不同）、
 * 会话级配置/注册表解析、以及 SSE 线上协议——斜杠发 `_tag` 形状 + done 收尾，
 * REST 发原生 result/error 事件，经 createEmitter 注入。
 */

/** SSE 事件发射器：两通道线上协议不同（事件名/载荷形状），由调用方提供实现。 */
interface WorkflowChannelEmitter {
  progress: (message: string, detail?: unknown) => Promise<void>
  result: (result: CommandResult) => Promise<void>
  error: (error: unknown) => Promise<void>
}

/** 斜杠通道线上协议：progress 带 _tag，终态翻译为 text_delta/error + done 收尾 * （与前端聊天 SSE 解析同构，工作流结果以对话消息呈现）。 */
function createSlashWorkflowEmitter(stream: SSEStreamingApi): WorkflowChannelEmitter {
  return {
    progress: async (message, detail) => {
      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify({ _tag: 'progress', message, detail }),
      })
    },
    result: async (result) => {
      if (result._tag === 'error') {
        await emitSseError(stream, result)
      } else {
        // executeWorkflow 只产出 text/error（success/compact 是斜杠命令泛型变体，不会到达）
        const text =
          result._tag === 'text' ? result.text : result._tag === 'success' ? result.message : ''
        await stream.writeSSE({
          event: 'text_delta',
          data: JSON.stringify({ _tag: 'text_delta', text }),
        })
      }
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ _tag: 'done' }) })
    },
    error: async (e) => {
      await emitSseError(stream, e, { swallow: true })
      await stream
        .writeSSE({ event: 'done', data: JSON.stringify({ _tag: 'done' }) })
        .catch(() => {})
    },
  }
}

/** REST 通道线上协议：progress 无 _tag，终态为原生 result 事件（无 done 收尾）。 */
function createRestWorkflowEmitter(stream: SSEStreamingApi): WorkflowChannelEmitter {
  return {
    progress: async (message, detail) => {
      await stream.writeSSE({ event: 'progress', data: JSON.stringify({ message, detail }) })
    },
    result: async (result) => {
      await stream.writeSSE({ event: 'result', data: JSON.stringify(result) })
    },
    error: async (e) => {
      await emitSseError(stream, e, { flat: true, swallow: true })
    },
  }
}

/** 共享通道参数（差异全部显式参数化）。 */
interface RunWorkflowChannelOptions {
  /** Hono 上下文（SSE 响应承载者）。 */
  c: Context
  registry: WorkflowRegistry
  name: string
  /** 已解析的工作流 entry（项目级优先，调用方按各自信任门禁解析）。 */
  entry: WorkflowEntry
  args: string
  /** 执行 cwd：工作流会话 worktreePath 与 deps.cwd 的统一口径。两通道语义同为
   *  「工作流执行目录」，仅来源不同——斜杠 = 宿主会话 resolveAgentCwd（项目
   *  worktree / 会话 worktreePath / serve cwd），REST = ?projectId 对应项目
   *  worktree（缺省 serve cwd）。有意参数化保留，不在此收敛。 */
  cwd: string
  /** 工作流会话绑定的项目 id：并发守卫作用域（project:<id> / dir:<cwd>）、
   *  工具集项目专属工具过滤、会话落盘三处共用。 */
  projectId?: string
  /** 会话级合并配置（预算护栏/工具集/超时动作取自此）。 */
  sessionConfig: Config
  /** 项目作用域显式默认权限模式（未设置时回退运行时全局模式）。 */
  sessionDefaultMode?: 'default' | 'auto'
  /** 会话级 LLM 注册表（项目 providers 合并构建，调用方缓存复用）。 */
  sessionRegistry: Registry
  /** 发起会话 id（斜杠通道）：工作流运行期间占用标记（workflowBusyBySession，
   *  普通消息 409 / 控制端点路由到工作流 run）+ 权限归属/模式查询键（用户停留
   *  的会话）。缺省（REST 通道）→ 权限归属工作流会话自身（树中可见节点）。 */
  hostSessionId?: string
  /** tryAcquire 失败文案（两通道历史文案不同，保持原样）。 */
  tryAcquireBusyMessage: string
  /** 权限超时级联暂停原因（透传给 pauseAgent 的状态栏文案，两通道各自传入）。 */
  permissionPauseReason: string
  /** SSE 事件发射器工厂（通道各自的线上协议）。 */
  createEmitter: (stream: SSEStreamingApi) => WorkflowChannelEmitter
}

/** 执行工作流并返回 SSE 响应（见模块注释；调用方保留各自的外壳与文案）。 */
async function runWorkflowChannel(
  ctx: ServerContext,
  opts: RunWorkflowChannelOptions,
): Promise<Response> {
  const { c, registry, name, entry, args, cwd, projectId } = opts

  // 并发守卫（同步原子占位）：执行作用域 = 项目或目录。此前 tryAcquire 作用在
  // 刚创建的全新会话 id 上（永真），且发起会话在整段工作流期间不注册任何
  // run——双发 /workflow run、REST 与斜杠并行都能并发执行。现在同一作用域
  // 仅允许一个工作流运行。
  // 注：REST 此前以原始 ?projectId 拼作用域键——项目已删除（getProject null）时
  // 执行目录实为 serve cwd，却挂在 `project:<死id>` 键下，与同目录的其他 run 不
  // 互斥。现统一按「绑定项目 ?? 执行目录」取键，作用域与真实执行目录一致。
  const scopeKey = projectId ? `project:${projectId}` : `dir:${cwd}`
  if (ctx.workflowBusyByScope.has(scopeKey)) {
    return apiError(
      c,
      409,
      'RUN_ACTIVE',
      '该项目/目录已有进行中的工作流执行，请等待完成或中止后重试',
    )
  }
  ctx.workflowBusyByScope.set(scopeKey, '')

  // 工作流运行会话：绑定项目 + 执行目录（与两通道此前同口径），标题带时间戳
  // 区分多次运行。中断恢复指引需要工作流名（重启后会话内无 user 消息可重发）。
  let workflowSession: Awaited<ReturnType<typeof createSession>>
  try {
    workflowSession = await createSession(
      ctx.db,
      workflowSessionTitle(name),
      projectId,
      'workflow',
      undefined,
      undefined,
      cwd,
      { workflowName: name },
      ctx.hookRunner,
    )
  } catch (e) {
    ctx.workflowBusyByScope.delete(scopeKey)
    throw e
  }
  ctx.workflowBusyByScope.set(scopeKey, workflowSession.id)
  // 发起会话在工作流运行期间视为占用（仅斜杠通道有发起会话）：普通消息 409；
  // 控制端点据此路由到工作流 run。
  if (opts.hostSessionId) {
    ctx.workflowBusyBySession.set(opts.hostSessionId, workflowSession.id)
  }
  const releaseWorkflowBusy = () => {
    if (ctx.workflowBusyByScope.get(scopeKey) === workflowSession.id) {
      ctx.workflowBusyByScope.delete(scopeKey)
    }
    if (
      opts.hostSessionId &&
      ctx.workflowBusyBySession.get(opts.hostSessionId) === workflowSession.id
    ) {
      ctx.workflowBusyBySession.delete(opts.hostSessionId)
    }
  }

  // 权限确认超时（双层超时兜底）后的动作：'pause'（默认）拒绝该工具并暂停 run，
  // 防 default 模式下 agent 在用户缺席时继续自主执行；'deny' 保持旧行为（run
  // 继续）。仅显式 'deny' 时选 deny，缺省/非法值一律 pause（安全默认）。
  const permissionTimeoutAction = resolvePermissionTimeoutAction(opts.sessionConfig)

  // P2-5：runner 的工具集不再恒 []——传配置解析结果作为子 agent 工具集的交集
  // 基准（与主 chat/CLI print 同口径）。config.tools.enabled 的 fail-closed 语义
  // 对工作流派发的子 agent 成立（全禁 → 交集为空）。runner 自身不进 agentLoop，
  // 工具名单不产生任何 LLM 调用影响。无项目绑定时剔除项目专属工具。
  const agentConfig: AgentConfig = {
    provider: opts.sessionConfig.defaultProvider,
    model: opts.sessionConfig.defaultModel,
    tools: resolveEnabledToolNames(ctx.toolRegistry, opts.sessionConfig).filter(
      (n) => Boolean(projectId) || !PROJECT_BOUND_TOOLS.has(n),
    ),
    plugins: opts.sessionConfig.plugins.enabled,
    agentName: 'default',
  }

  // 并发占位：同步原子占位，SSE 回调内 register 填充。
  if (!ctx.agentManager.tryAcquire(workflowSession.id)) {
    releaseWorkflowBusy()
    return apiError(c, 409, 'RUN_ACTIVE', opts.tryAcquireBusyMessage)
  }
  // 持久化 run 状态：运行中 → completed。服务崩溃时停留在 running，
  // 重启后 /:id/status 据此识别为 interrupted。
  const startedAtMs = Date.now()
  await updateSessionLastRun(ctx.db, workflowSession.id, {
    status: 'running',
    startedAt: startedAtMs,
  }).catch(() => {})
  let handedOff = false
  try {
    const response = streamSSE(c, async (stream) => {
      const stopHeartbeat = startHeartbeat(stream)
      const emit = opts.createEmitter(stream)
      try {
        // 权限归属键：斜杠通道 = 发起会话（用户停留的会话，刷新/切换页面后按当前
        // 会话重挂挂起弹窗）；REST 通道 = 工作流会话自身（树中可见节点，打开该
        // 会话即可重挂全部挂起弹窗）。
        const permissionSessionId = opts.hostSessionId ?? workflowSession.id
        const permissionChecker = createStreamPermissionChecker(ctx, {
          stream,
          sessionId: permissionSessionId,
          defaultMode: opts.sessionDefaultMode,
          timeoutAction: permissionTimeoutAction,
          // P1 级联暂停：仅暂停父 run 会让子 agent 在用户缺席时继续执行。
          onPauseExpired: () =>
            ctx.agentManager.pauseCascade(workflowSession.id, opts.permissionPauseReason),
        })

        // deps 单点组装：两通道此前各自复制，斜杠副本已漂移（缺 skills/debugSpawn）。
        const deps = {
          db: ctx.db,
          llmRegistry: opts.sessionRegistry,
          toolRegistry: ctx.toolRegistry,
          urlRegistry: ctx.urlRegistry,
          hookRunner: ctx.hookRunner,
          permission: permissionChecker,
          config: opts.sessionConfig,
          cwd,
          agentRegistry: ctx.agentRegistry,
          registerChildRun: childRunBridge(ctx.agentManager),
          // 技能发现（system prompt ## Loaded Skills 段数据源）。
          skills: discoverSkills(cwd),
          // DAP（spec §21）：与主 chat/CLI 通道同口径注入真实适配器 spawn。
          debugSpawn: createDebugSpawn() as LoopDeps['debugSpawn'],
          // 预算护栏：与主 chat 路由同口径（金额/token 任一轴 pause/abort 即启用）。
          ...(budgetGateEnabled(opts.sessionConfig.usage) ? { budgetPause: true } : {}),
        }

        const parent = await createAgent(workflowSession, agentConfig, deps)
        ctx.agentManager.register({ sessionId: workflowSession.id, state: parent, deps })
        stream.onAbort(() => {
          ctx.agentManager.abort(workflowSession.id)
        })

        const result = await executeWorkflow({
          registry,
          name,
          entry,
          args,
          deps,
          parent,
          onProgress: async (message, detail) => {
            await emit.progress(message, detail)
          },
        })
        await emit.result(result)
      } catch (e) {
        await emit.error(e)
      } finally {
        stopHeartbeat()
        ctx.agentManager.unregister(workflowSession.id)
        void updateSessionLastRun(ctx.db, workflowSession.id, {
          status: 'completed',
          startedAt: startedAtMs,
        }).catch(() => {})
        releaseWorkflowBusy()
      }
    })
    handedOff = true
    return response
  } finally {
    if (!handedOff) {
      ctx.agentManager.unregister(workflowSession.id)
      releaseWorkflowBusy()
    }
  }
}

export {
  createRestWorkflowEmitter,
  createSlashWorkflowEmitter,
  type RunWorkflowChannelOptions,
  runWorkflowChannel,
}
