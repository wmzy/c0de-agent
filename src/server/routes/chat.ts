import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { type Context, Hono } from 'hono'
import { type SSEStreamingApi, streamSSE } from 'hono/streaming'
import { createAgent, runAgent } from '../../core/agent.js'
import { type Config, loadConfigScopes } from '../../core/config.js'
import type { LoopDeps } from '../../core/loop.js'
import { compactContext } from '../../core/loop.js'
import { discoverSkills } from '../../core/skills.js'
import { createSlashRegistry, isSlashCommandEnabled, parseSlashInput } from '../../core/slash.js'
import { injectSteering } from '../../core/steering.js'
import type { RegisterChildRun } from '../../core/types.js'
import { buildWorkflowNotice, containsWorkflow } from '../../core/workflow.js'
import {
  createWorkflowRegistry,
  discoverWorkflows,
  resolveWorkflow,
} from '../../core/workflows/index.js'
import { createDebugSpawn } from '../../dap/index.js'
import type { Registry } from '../../llm/registry.js'
import { resolveRoute } from '../../llm/registry.js'
import { getProject } from '../../project/project.js'
import { enrichProjectRiskWithGlobal, projectTrustNeeded } from '../../project/trust.js'
import { insertEntry } from '../../session/message.js'
import { getLLMSegments } from '../../session/segments.js'
import {
  consumeBudgetPauseMarker,
  getSession,
  markUnfinishedTurn,
  updateSessionLastRun,
} from '../../session/session.js'
import { upsertFileSnapshot } from '../../session/snapshot.js'
import { upgradeTemporarySession } from '../../session/trash.js'
import { budgetGateEnabled } from '../../session/usage.js'
import type { AgentConfig } from '../../shared/types/agent.js'
import type { MessageContent } from '../../shared/types/message.js'
import { PROJECT_BOUND_TOOLS, resolveEnabledToolNames } from '../../tools/index.js'
import { autoAllowChecker } from '../../tools/permission.js'
import type { AgentManager } from '../agent-manager.js'
import { apiError } from '../middleware/error.js'
import {
  createStreamPermissionChecker,
  resolvePermissionTimeoutAction,
} from '../permission/stream-checker.js'
import type { ServerContext } from '../types.js'
import { readJsonObject } from '../util/json-body.js'
import { safeResolve } from '../util/safe-path.js'
import { resolveSessionScope } from '../util/session-scope.js'
import { createSlashWorkflowEmitter, runWorkflowChannel } from './workflow-run.js'

/** getSession 的返回类型（含 null）；路由层守卫块的公共输入。 */
type ChatSession = Awaited<ReturnType<typeof getSession>>

/** resolveAgentCwd 的失败种类：上层据此分流 409（PROJECT_MISSING/WORKTREE_MISSING）。
 *  此前用消息字符串前缀约定 + startsWith/replace 解码，改为 instanceof + kind
 *  （消息仍保留「KIND: 」前缀，测试与日志可读）。 */
class AgentCwdError extends Error {
  readonly kind: 'PROJECT_MISSING' | 'WORKTREE_MISSING'

  constructor(kind: 'PROJECT_MISSING' | 'WORKTREE_MISSING', message: string) {
    super(message)
    this.kind = kind
  }
}

/** 按 session.projectId / worktreePath 解析 agent 工作目录：
 *  - 有 projectId → 项目 worktree（缺失/目录失效时抛错，由上层转 409）。
 *  - 无 projectId（项目已删除后从回收站恢复的会话）→ 用 worktreePath 兜底：
 *    目录失效同样抛错，绝不静默回退 serve cwd 导致 agent 在错误目录执行工具。
 *  - 两者皆无（从未绑定项目的会话，如 CLI print）→ 回退 ctx.cwd。 */
export async function resolveAgentCwd(
  ctx: ServerContext,
  session: { projectId: string | null; worktreePath?: string | null },
): Promise<string> {
  if (!session.projectId) {
    if (!session.worktreePath) return ctx.cwd
    if (!existsSync(session.worktreePath)) {
      throw new AgentCwdError(
        'WORKTREE_MISSING',
        `WORKTREE_MISSING: 会话工作目录已失效（${session.worktreePath}）。请检查目录是否被移动或删除`,
      )
    }
    return session.worktreePath
  }
  const project = await getProject(ctx.db, session.projectId)
  if (!project) {
    throw new AgentCwdError(
      'PROJECT_MISSING',
      `PROJECT_MISSING: 会话所属项目已不存在（projectId=${session.projectId}）`,
    )
  }
  if (!existsSync(project.worktree)) {
    throw new AgentCwdError(
      'WORKTREE_MISSING',
      `WORKTREE_MISSING: 项目工作目录已失效（${project.worktree}）。请检查目录是否被移动或删除`,
    )
  }
  return project.worktree
}

/**
 * SSE 心跳间隔。前端有 90s 静默看门狗（web/services/chat.ts），而服务端各
 * 等待语义远长于此：bash 默认超时 120s、权限确认 5 分钟、子 agent 执行数分钟。
 * 这些等待期间没有业务事件帧——若无心跳，前端会在 90s 时 abort 连接，
 * 服务端 stream.onAbort 随即中止 agent，长命令/权限弹窗/多 agent 全部误杀。
 * 30s 心跳保证看门狗只对「连接真正死亡」（连续 3 个心跳周期无数据）生效。
 */
/** 权限确认超时兜底拒绝后暂停 run 的暂停原因（区别于用户主动暂停）。
 *  附重试指引：被拒工具不会自动重试，用户回来后需要知道可以要求 agent 重做。 */
const PERMISSION_TIMEOUT_PAUSE_REASON =
  '权限确认超时：该工具已被自动拒绝，对话已暂停。点击「恢复」后可直接要求 agent 重试该工具'

const SSE_HEARTBEAT_INTERVAL_MS = 30_000

/** 启动心跳定时器；返回停止函数（幂等）。流关闭后写入会被吞掉，安全。 */
function startHeartbeat(stream: SSEStreamingApi): () => void {
  const timer = setInterval(() => {
    stream.writeSSE({ event: 'heartbeat', data: '' }).catch(() => {}) // 流已关闭/客户端断开时写入失败，忽略
  }, SSE_HEARTBEAT_INTERVAL_MS)
  return () => clearInterval(timer)
}

export { SSE_HEARTBEAT_INTERVAL_MS, startHeartbeat }

/**
 * 子 agent run 注册桥接：core 的 registerChildRun → agentManager 槽位。
 * P1：此前子 run（含后台任务）从不注册，暂停/热更新/删除级联/更新影响面
 * 全部绕过它们；core 无 agentManager 引用，桥接由 Web 宿主注入。
 * 返回的注销函数幂等（unregister 对不存在的 key 安全）。
 */
export function childRunBridge(manager: AgentManager): RegisterChildRun {
  return (run) => {
    manager.register({
      sessionId: run.sessionId,
      parentSessionId: run.parentSessionId,
      jobId: run.jobId,
      state: run.state,
      deps: run.deps,
    })
    return () => manager.unregister(run.sessionId)
  }
}

/**
 * 会话「忙」判定统一口径：活跃 run / tryAcquire 占位（starting）/ 工作流运行期
 * （发起会话无主 run，busy 映射承载）。变更型操作（fork/compact/clear 等）在斜杠与
 * REST 双入口共用本判定，防止守卫漂移——REST fork 此前只查 get()，漏 starting
 * 占位窗口与工作流运行期两种态（斜杠守卫早已覆盖）。
 */
export function hasBusySession(
  ctx: ServerContext,
  sessionId: string,
): 'run' | 'starting' | 'workflow' | null {
  if (ctx.agentManager.get(sessionId)) return 'run'
  if (ctx.agentManager.isStarting(sessionId)) return 'starting'
  if (ctx.workflowBusyBySession.has(sessionId)) return 'workflow'
  return null
}

/** 「会话忙」双 409 守卫：活跃 run / 工作流运行期 → RUN_ACTIVE（动词拼提示文案），
 *  启动占位 → RUN_STARTING。session.ts 的 fork/rebind/compact/shake 与本文件的
 *  变更型斜杠命令共用（此前五处内联，文案与错误码已开始漂移）。 */
export function guardSessionNotBusy(
  ctx: ServerContext,
  c: Context,
  sessionId: string,
  verb: string,
): Response | undefined {
  const busy = hasBusySession(ctx, sessionId)
  if (busy === 'run' || busy === 'workflow') {
    return apiError(c, 409, 'RUN_ACTIVE', `该会话已有进行中的对话，请等待完成或中止后再${verb}`)
  }
  if (busy === 'starting') {
    return apiError(c, 409, 'RUN_STARTING', '该会话的对话正在启动，请稍后重试')
  }
  return undefined
}

/** getLiveSessionOr404 的判别结果：ok=false 时 response 为可直接 return 的 404。 */
type LiveSessionResult =
  | { ok: true; session: Exclude<ChatSession, null> }
  | { ok: false; response: Response }

/** getSession 守卫块统一口径（session.ts 各端点 + 本文件 POST /）：查询异常/
 *  不存在 → 404；requireLive（默认）时回收站会话同样 404。两种历史文案
 *  （'Session not found' / '会话不存在或已删除'）经 opts 逐点保留；try/catch
 *  收在 helper 内（id 未过 UUID 守卫的调用方此前各自内联）。requireLive=false
 *  的端点（fork 之外的 archives/compact/shake 等历史不查 deletedAt 的口径）
 *  显式传 false，口径漂移从此显式。 */
export async function getLiveSessionOr404(
  ctx: ServerContext,
  c: Context,
  id: string,
  opts: {
    requireLive?: boolean
    notFoundMessage?: string
    deletedMessage?: string
  } = {},
): Promise<LiveSessionResult> {
  const requireLive = opts.requireLive ?? true
  const notFoundMessage = opts.notFoundMessage ?? 'Session not found'
  const deletedMessage = opts.deletedMessage ?? '会话不存在或已删除'
  let session: ChatSession
  try {
    session = await getSession(ctx.db, id)
  } catch {
    return { ok: false, response: apiError(c, 404, 'NOT_FOUND', notFoundMessage) }
  }
  if (!session) {
    return { ok: false, response: apiError(c, 404, 'NOT_FOUND', notFoundMessage) }
  }
  if (requireLive && session.deletedAt) {
    return { ok: false, response: apiError(c, 404, 'NOT_FOUND', deletedMessage) }
  }
  return { ok: true, session }
}

/** readSessionIdBody 的判别结果：ok=false 时 response 为可直接 return 的 400。 */
type SessionIdBodyResult =
  | { ok: true; sessionId: string; body: Record<string, unknown> }
  | { ok: false; response: Response }

/** 控制端点（/abort /pause /resume /steer）的 sessionId 提取：基于
 *  readJsonObject——畸形 JSON / 非对象 body → 400（此前四端点各 6 行内联解构，
 *  null body 在解构处 TypeError 500 / 静默当缺 sessionId）。返回 body 供
 *  /steer 读取 message（Request body 只能读一次，不能二次解析）。 */
async function readSessionIdBody(c: Context): Promise<SessionIdBodyResult> {
  const parsed = await readJsonObject(c)
  if (!parsed.ok) return { ok: false, response: parsed.response }
  const sessionId = typeof parsed.body.sessionId === 'string' ? parsed.body.sessionId : ''
  if (!sessionId) {
    return { ok: false, response: apiError(c, 400, 'BAD_REQUEST', 'sessionId is required') }
  }
  return { ok: true, sessionId, body: parsed.body }
}

/** POST / 各阶段解析出的会话级执行环境（阶段函数间的传递载体）。 */
type ChatRunEnv = {
  c: Context
  ctx: ServerContext
  sessionId: string
  session: Exclude<ChatSession, null>
  body: Record<string, unknown>
  message: string | undefined
  images: Array<{ mediaType: string; data: string }> | undefined
  cwd: string
  sessionConfig: Config
  sessionDefaultMode: 'default' | 'auto' | undefined
  sessionRegistry: Registry
  permissionTimeoutAction: 'pause' | 'deny'
}

type ChatStageResult<T> = { ok: true; value: T } | { ok: false; response: Response }

/** 阶段 1：请求体校验——畸形 JSON → 400；sessionId/文本/图片皆缺 → 400；
 *  图片数量/形状/解码字节数限额（服务端兜底，API 直调/旧客户端）。 */
async function parseChatRequestBody(c: Context): Promise<
  ChatStageResult<{
    body: Record<string, unknown>
    sessionId: string
    message: string | undefined
    images: Array<{ mediaType: string; data: string }> | undefined
  }>
> {
  // 畸形 JSON / null / 非对象 body → 400（此前 null body 在 body.sessionId 处
  // TypeError 500；数字 sessionId 会一路进 PG 的 uuid 参数 → 22P02 500）。
  const bodyParsed = await readJsonObject(c)
  if (!bodyParsed.ok) return { ok: false, response: bodyParsed.response }
  const { body } = bodyParsed
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
  // body 字段形状校验（P3 加固）：message 非字符串（number/object）会通过
  // 「!message」检查后经 parseSlashInput 的 .trim() 击穿 TypeError 500——
  // 按缺省处理落入下方空消息 400，而非 500。
  const message = typeof body.message === 'string' ? body.message : undefined
  const images = body.images as Array<{ mediaType: string; data: string }> | undefined

  // P1-5：纯图片消息放行（Composer 允许只带图片不带文本），
  // 仅当文本与图片皆无时拒绝，错误信息说明可操作原因。
  if (!sessionId || (!message && !images?.length)) {
    return {
      ok: false,
      response: apiError(c, 400, 'BAD_REQUEST', '消息内容不能为空：请输入文字或附带图片后再发送'),
    }
  }
  // P0：图片大小/数量服务端限额（前端已限制，此为兜底——API 直调/旧客户端）。
  // P3 加固：条目形状（对象 + string mediaType/data + image/ 前缀）显式 400——
  // images 非数组 → for-of TypeError；[null] → 读 null.data TypeError；缺字段
  // 条目此前静默持久化成毒化图片消息（jsonb 丢弃 undefined 字段），后续每轮
  // 上下文重建都携带破损图片，provider 恒 400，会话无法继续。
  if (images !== undefined) {
    if (!Array.isArray(images)) {
      return { ok: false, response: apiError(c, 400, 'INVALID_IMAGES', 'images 必须是数组') }
    }
    const MAX_IMAGE_COUNT = 6
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024
    if (images.length > MAX_IMAGE_COUNT) {
      return {
        ok: false,
        response: apiError(
          c,
          400,
          'TOO_MANY_IMAGES',
          `最多 ${MAX_IMAGE_COUNT} 张图片（收到 ${images.length} 张）`,
        ),
      }
    }
    for (const img of images) {
      if (
        img === null ||
        typeof img !== 'object' ||
        Array.isArray(img) ||
        typeof img.mediaType !== 'string' ||
        !img.mediaType.startsWith('image/') ||
        typeof img.data !== 'string' ||
        img.data.length === 0
      ) {
        return {
          ok: false,
          response: apiError(
            c,
            400,
            'INVALID_IMAGE',
            'images 每项必须是 { mediaType: "image/...", data: "<base64>" }',
          ),
        }
      }
      // P3：按解码字节校验（base64 字符串长度比真实字节约大 33%）；
      // 无法解码（非法 base64/含 dataURL 前缀等）时按字符串长度保守拦截。
      let bytes = img.data.length
      try {
        bytes = Buffer.from(img.data, 'base64').length
      } catch {
        // 解码失败保留字符串长度兜底
      }
      if (bytes > MAX_IMAGE_BYTES) {
        const mb = (bytes / (1024 * 1024)).toFixed(1)
        return {
          ok: false,
          response: apiError(
            c,
            400,
            'IMAGE_TOO_LARGE',
            `图片大小 ${mb}MB 超过上限 ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`,
          ),
        }
      }
    }
  }
  return { ok: true, value: { body, sessionId, message, images } }
}

/** 阶段 2：会话恢复——拉取（404 守卫）+ 拒绝回收站 + workflow 临时会话升级
 *  （续接即持久）+ 会话级权限态（覆盖模式/始终允许白名单）从 metadata 恢复
 *  到内存（重启后 getMode 的会话覆盖优先级才成立）。 */
async function restoreChatSession(
  ctx: ServerContext,
  c: Context,
  sessionId: string,
): Promise<ChatStageResult<Exclude<ChatSession, null>>> {
  const live = await getLiveSessionOr404(ctx, c, sessionId, {
    deletedMessage: '会话不存在或已删除（如需继续对话请先从回收站恢复）',
  })
  if (!live.ok) return live
  const session = live.session
  // P1-3：继续对话的 workflow 会话升级为持久会话——「续接即持久」此前仅
  // 覆盖 CLI print（upgradeTemporarySession 只被 print --continue 调用），
  // workflow 会话在 Web 继续追问后仍会被 30 天临时清理移入回收站。
  if (session.agentType === 'workflow') {
    await upgradeTemporarySession(ctx.db, sessionId).catch(() => {
      // 升级失败不阻塞对话（最坏仍按临时会话清理）
    })
  }

  // P2：会话级权限覆盖持久化在 metadata——重启后从 DB 恢复到内存 Map，
  // 使 getMode 的「会话覆盖」优先级跨重启成立。
  if (session.metadata.permissionMode === 'auto' || session.metadata.permissionMode === 'default') {
    ctx.sessionPermissionModes.set(sessionId, session.metadata.permissionMode)
  }
  // P2：会话级「始终允许」白名单同样持久化于 metadata，checker 经 getter 实时读取
  // （run 期间用户可追加；此处仅在本会话 Map 尚未加载时注入，已有值优先）。
  if (!ctx.sessionAlwaysAllow.has(sessionId)) {
    const list = (session.metadata as { alwaysAllow?: unknown }).alwaysAllow
    ctx.sessionAlwaysAllow.set(
      sessionId,
      Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : [],
    )
  }
  return { ok: true, value: session }
}

/** 阶段 3：会话级配置/注册表解析 + 项目信任门禁。
 *  P1 多项目配置：会话级配置按会话工作目录解析（该项目 .c0de/config.json 的原始
 *  作用域合并到服务级配置之上）。此前所有项目共用启动目录配置——在其他项目里
 *  修改「项目配置」实际写的是启动项目。cwd === ctx.cwd 时直接复用服务级配置。
 *  权限默认模式单独取原始 project 作用域：项目文件未显式设置时回退运行时全局
 *  模式（启动默认或 PUT /api/permissions 覆盖），避免启动项目配置泄漏到其他项目。
 *  P0-2 项目信任门禁：未信任项目（或信任后配置漂移）+ 项目作用域原始配置含
 *  风险项（auto 权限 / timeoutAction=deny 降级 / 启用项目插件 / MCP）→ 409
 *  TRUST_REQUIRED，前端弹窗明示风险，用户显式信任（POST /projects/:id/trust）
 *  后重发。只评估项目作用域原始配置（全局配置是用户本机显式编辑，天然可信）；
 *  信任非永久：trustedAt 落盘时附带风险指纹，其后仓库 git pull 新增风险键
 *  （指纹漂移）同样重新触发门禁（P1 信任指纹复检）。 */
async function resolveChatProjectEnv(
  ctx: ServerContext,
  c: Context,
  session: Exclude<ChatSession, null>,
  cwd: string,
): Promise<
  ChatStageResult<{
    sessionConfig: Config
    sessionDefaultMode: 'default' | 'auto' | undefined
    sessionRegistry: Registry
    permissionTimeoutAction: 'pause' | 'deny'
  }>
> {
  // P1-1：会话项目注册表——项目级配置含 providers 时，按该项目合并配置
  // 构建/复用 LLM 注册表（否则项目配置的 provider 永远 NoRoute）。
  // 服务启动目录项目直接复用服务级注册表。
  const scope = resolveSessionScope(ctx, { cwd, registryKey: session.projectId ?? undefined })
  const sessionConfig = scope.config
  const sessionDefaultMode = scope.projectScope?.permission?.defaultMode
  if (session.projectId) {
    const project = await getProject(ctx.db, session.projectId)
    if (project) {
      const scopes = loadConfigScopes(cwd)
      const risks = projectTrustNeeded(
        scopes.project,
        scopes.global,
        project.trustedAt,
        project.riskFingerprint,
        project.worktree,
      )
      if (risks.length > 0) {
        // 并入全局配置的权限风险上下文（不改变门禁触发条件）：用户做信任决策时
        // 能看到完整生效的权限状态（如全局已 auto），避免「信任了项目却困惑于
        // 权限为何仍自动放行」。
        const items = enrichProjectRiskWithGlobal(risks, scopes.global)
        return {
          ok: false,
          response: apiError(
            c,
            409,
            'TRUST_REQUIRED',
            `项目「${project.name ?? project.worktree}」的项目配置（.c0de/config.json）包含需要你确认的风险项`,
            { projectId: project.id, projectName: project.name ?? project.worktree, items },
          ),
        }
      }
    }
  }
  return {
    ok: true,
    value: {
      sessionConfig,
      sessionDefaultMode,
      sessionRegistry: scope.registry,
      permissionTimeoutAction: resolvePermissionTimeoutAction(sessionConfig),
    },
  }
}

/** /workflow run 专用执行通道：与 REST POST /api/workflows/:name/run 同口径——
 *  预算护栏、urlRegistry/hookRunner、agentManager 注册 + 断连 abort、进度 SSE。
 *  此前经通用 commandCtx.deps 执行：子 agent 预算旁路（P0）、内部 URL 解析失败、
 *  run 游离于 agentManager（不可中止、热更新不可见）。 */
async function runWorkflowSlashChannel(
  ctx: ServerContext,
  opts: {
    c: Context
    /** 发起会话：工作流运行期间占用标记 + 权限归属/模式查询键。 */
    sessionId: string
    /** 宿主会话绑定的项目（项目级工作流发现/解析的门禁口径）。 */
    projectId: string | null
    cwd: string
    sessionConfig: Config
    sessionDefaultMode: 'default' | 'auto' | undefined
    sessionRegistry: Registry
    workflowArgs: string
  },
): Promise<Response> {
  const { c, sessionId, projectId, cwd, sessionConfig } = opts
  // 并发守卫：主 run 活跃时不允许同会话发起工作流（权限弹窗/预算/终端混淆）。
  if (ctx.agentManager.get(sessionId) || ctx.agentManager.isStarting(sessionId)) {
    return apiError(c, 409, 'RUN_ACTIVE', '该会话已有进行中的对话，请等待完成或中止后再运行工作流')
  }
  const parts = opts.workflowArgs.split(/\s+/).filter(Boolean)
  const name = parts[1]
  if (!name) {
    return apiError(c, 400, 'BAD_REQUEST', 'Usage: /workflow run <name> [args]')
  }
  const wfArgs = parts.slice(2).join(' ')
  const registry = ctx.workflowRegistry ?? createWorkflowRegistry()
  // 统一解析：项目级（已信任）> 用户 > 内置。仅在会话已绑定项目时发现
  // 项目级工作流——聊天门禁已保证该项目可信且指纹未漂移；孤儿会话
  // （无 projectId）不再按 cwd 无条件发现：其目录未注册、信任状态未知，
  // 此前会在未信任仓库直接 dynamic import 其工作流代码。
  let entry = ctx.workflowRegistry?.get(name)
  if (projectId) {
    entry =
      (await resolveWorkflow({
        name,
        registry,
        projectDir: cwd,
        projectTrusted: true,
      })) ?? entry
  }
  if (!entry) {
    // 错误提示里列出可用工作流：仅在会话绑定项目（门禁已通过）时发现
    // 项目级——与上方解析同口径，不因「拼错名字」在未信任目录执行仓库代码。
    const discovered = projectId ? await discoverWorkflows(cwd) : []
    const available = [
      ...registry.list().map((e) => e.meta.name),
      ...discovered.map((e) => e.meta.name),
    ].join(', ')
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'text_delta',
        data: JSON.stringify({
          _tag: 'text_delta',
          text: `未知工作流："${name}"。可用：${available || '(无)'}`,
        }),
      })
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ _tag: 'done' }) })
    })
  }

  // 执行通道与 REST POST /api/workflows/:name/run 共享（workflow-run.ts 单点
  // 实现）：并发守卫（scope/tryAcquire）、会话生命周期、权限 checker（超时
  // 级联暂停）、deps 组装（skills/debugSpawn 注入一次）、abort 级联、预算
  // 门禁；线上协议（`_tag` 形状 + done 收尾）由斜杠 emitter 提供。
  return runWorkflowChannel(ctx, {
    c,
    registry,
    name,
    entry,
    args: wfArgs,
    // cwd 口径：宿主会话经 resolveAgentCwd 解析（项目 worktree / 会话
    // worktreePath / serve cwd）——REST 通道按 ?projectId → project.worktree
    // 解析。语义同为「工作流执行目录」，仅来源不同，见 workflow-run.ts。
    cwd,
    projectId: projectId ?? undefined,
    sessionConfig,
    sessionDefaultMode: opts.sessionDefaultMode,
    sessionRegistry: opts.sessionRegistry,
    // 发起会话：工作流运行期间占用标记 + 权限归属/模式查询键（REST 无发起会话）。
    hostSessionId: sessionId,
    tryAcquireBusyMessage: '该工作流会话已有进行中的执行',
    permissionPauseReason: PERMISSION_TIMEOUT_PAUSE_REASON,
    createEmitter: createSlashWorkflowEmitter,
  })
}

/** 阶段 4：斜杠命令分发。返回 undefined = 非命令或未知命令：回退为正常消息
 *  发给 agent。含变更型命令 busy 守卫、enabled 过滤、/workflow run 专用通道、
 *  /compact 压缩分支与通用命令执行（SSE 心跳 + 权限 checker 注入）。 */
async function dispatchSlashCommand(
  env: ChatRunEnv,
  parsed: { name: string; args: string },
): Promise<Response | undefined> {
  const { ctx, c, sessionId, body, sessionConfig, sessionDefaultMode, sessionRegistry, cwd } = env
  const registry = createSlashRegistry()
  const cmd = registry.get(parsed.name)
  if (!cmd) return undefined
  // P3：变更型命令（清空/压缩/分支直接改写消息树）与活跃 run 的并发
  // 写入存在竞态——斜杠拦截早于 tryAcquire，须在此显式拒绝。
  // 守卫口径统一为 hasBusySession（get + isStarting + workflowBusy）。
  const MUTATING_SLASH = new Set(['compact', 'clear', 'fork'])
  if (MUTATING_SLASH.has(parsed.name)) {
    const busy = guardSessionNotBusy(ctx, c, sessionId, `执行 /${parsed.name}`)
    if (busy) return busy
  }
  // P2-4：执行 config.slashCommands.enabled 过滤（此前该配置无任何消费方）。
  // enabled 为空 = 全部禁用（fail-closed）；含 ['*'] = 全部启用；名称兼容带/不带前缀斜杠。
  if (!isSlashCommandEnabled(sessionConfig.slashCommands?.enabled, parsed.name)) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'text_delta',
        data: JSON.stringify({
          _tag: 'text_delta',
          text: `斜杠命令 /${parsed.name} 未启用（config.slashCommands.enabled）`,
        }),
      })
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ _tag: 'done' }) })
    })
  }
  // /workflow run 走专用通道（预算/URL 注册表/agentManager 生命周期与 REST 同口径）；
  // 其余 workflow 子命令（list/show/create/edit）继续走通用 commandCtx。
  if (parsed.name === 'workflow' && /^run(?:\s|$)/.test(parsed.args.trim())) {
    return runWorkflowSlashChannel(ctx, {
      c,
      sessionId,
      projectId: env.session.projectId,
      cwd,
      sessionConfig,
      sessionDefaultMode,
      sessionRegistry,
      workflowArgs: parsed.args.trim(),
    })
  }
  const commandCtx = {
    cwd,
    config: sessionConfig,
    // 当前会话 id：/clear /fork 等命令默认作用于当前会话（P2-4）。
    sessionId,
    // 消费渠道：/model 等命令按渠道给指引（Web 有底部模型选择器）。
    channel: 'web' as const,
    // 内置斜杠命令（/clear、/fork、/config）仅需 db + config；
    // 但 /workflow run 会走 executeWorkflow → buildWorkflowContext → runSubAgent，
    // 该路径需要 agentRegistry 来派生子 agent，因此必须注入。
    workflowRegistry: ctx.workflowRegistry,
    deps: {
      db: ctx.db,
      config: sessionConfig,
      cwd,
      // P1 工作流权限：占位 checker 在 streamSSE 回调内被替换为交互式
      // checker——/workflow run 的子 agent 才能对 ask 工具弹窗确认。
      permission: autoAllowChecker,
      toolRegistry: ctx.toolRegistry,
      llmRegistry: sessionRegistry,
      urlRegistry: ctx.urlRegistry,
      hookRunner: ctx.hookRunner,
      agentRegistry: ctx.agentRegistry,
      registerChildRun: childRunBridge(ctx.agentManager),
      // 预算护栏：/compact 的压缩 LLM 调用与子 agent 同样受护栏约束
      //（金额/token 任一轴动作为 pause/abort 即启用）。
      ...(budgetGateEnabled(sessionConfig.usage) ? { budgetPause: true } : {}),
    },
  }
  return streamSSE(c, async (stream) => {
    const stopHeartbeat = startHeartbeat(stream)
    try {
      // P1 工作流权限：子命令（尤其 /workflow run）的子 agent 继承此 checker。
      // 此前用 autoAllowChecker：ask 工具返回 permission_required 结果但无
      // 确认通道（confirm 是 no-op），写/执行工具在工作流里静默不可用。
      // 现在与主 agent 一致：permission_required 经 SSE 弹窗，用户确认后
      // 经 /api/tools/confirm 消费全局 store。
      const permissionChecker = createStreamPermissionChecker(ctx, {
        stream,
        sessionId,
        defaultMode: sessionDefaultMode,
        timeoutAction: env.permissionTimeoutAction,
        onPauseExpired: () =>
          ctx.agentManager.pauseCascade(sessionId, PERMISSION_TIMEOUT_PAUSE_REASON),
      })
      const streamCommandCtx = {
        ...commandCtx,
        deps: { ...commandCtx.deps, permission: permissionChecker },
      }
      const result = await cmd.execute(parsed.args, streamCommandCtx)
      if (result._tag === 'compact') {
        // /compact：手动触发上下文压缩。复用 loop.compactContext（createSummarizer +
        // compactSession），不创建主 agent、不进入 LLM turn 循环（不把 /compact 当作
        // user 消息发给模型）。
        const provider = (body.provider as string) ?? sessionConfig.defaultProvider
        const model = (body.model as string) ?? sessionConfig.defaultModel
        const agentConfig: AgentConfig = {
          provider,
          model,
          tools: [],
          plugins: sessionConfig.plugins.enabled,
          agentName: 'default',
        }
        const compactState = await createAgent(env.session, agentConfig, commandCtx.deps)
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
    } finally {
      stopHeartbeat()
    }
  })
}

/** 阶段 5：构建多模态 user content：文本在前（可为空串/缺省，纯图片消息），
 *  images（dataURL base64）在后 + @agent subagent 指令注入 + @文件上下文快照。 */
async function buildUserContent(env: ChatRunEnv): Promise<ChatStageResult<MessageContent[]>> {
  const { ctx, c, cwd, body, message, images } = env
  // 文本为空时跳过 text part，避免把空文本发给模型。
  const userContent: MessageContent[] = message ? [{ _tag: 'text', text: message }] : []
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
    // P3-10 修复：部分无效也显式 400——此前仅全无效报错，拼错 1 个时该提及
    // 被静默丢弃、用户以为已派发。列出全部无效名，供用户修正后重发。
    const validNames = new Set(valid.map((d) => d.name))
    const invalid = mentionedAgents.filter((n) => !validNames.has(n))
    if (invalid.length > 0) {
      return {
        ok: false,
        response: apiError(
          c,
          400,
          'INVALID_AGENT_MENTION',
          `未知或非 subagent 类型的 agent 提及：${invalid.join(', ')}`,
        ),
      }
    }
    const names = valid.map((d) => d.name).join(', ')
    const first = userContent[0]
    if (first && first._tag === 'text') {
      first.text = `[User requested subagent(s): ${names}]\n\n${first.text}`
    } else {
      // 纯图片消息：前置文本 part 承载 subagent 指令，避免指令静默丢失
      userContent.unshift({ _tag: 'text', text: `[User requested subagent(s): ${names}]` })
    }
  }

  // @文件上下文：读取文件内容写入快照，后续 getSessionContext→injectSnapshots 自动注入。
  // 快照记录文件 mtime——注入前比对磁盘，过期自动刷新（P1-5）。
  // 路径越界或读取失败静默跳过，不阻塞主对话流。
  const files = body.files as string[] | undefined
  if (files?.length) {
    for (const p of files) {
      // 非字符串条目（number/object）进 safeResolve 会让 node:path resolve
      // 抛 TypeError 击穿 500——按「读取失败静默跳过」同口径忽略。
      if (typeof p !== 'string' || p.length === 0) continue
      const resolved = safeResolve(cwd, p)
      if (!resolved) continue
      try {
        // 先 stat 再 readFile（与 session/context.ts 刷新路径一致）：若先读后
        // stat，文件恰在两次调用间被写会存「旧内容 + 新 mtime」，注入前的
        // mtime 相等判定使旧内容被永久钉住；先 stat 后读最坏存「新内容 +
        // 旧 mtime」，下次注入仍会触发刷新，可自愈。
        const st = await stat(resolved)
        const content = await readFile(resolved, 'utf-8')
        await upsertFileSnapshot(ctx.db, env.sessionId, p, content, st.mtimeMs)
      } catch {
        // 文件读取失败静默跳过
      }
    }
  }
  return { ok: true, value: userContent }
}

/** 阶段 6：provider/model 解析 + 首次运行引导预检。
 *  P1-1：默认 provider/model 按会话项目配置解析（此前用服务启动目录配置，
 *  其他项目的 defaultProvider 设置被静默忽略）。
 *  P0-1：provider 未配置/未注册时立即返回可操作错误，不让错误延迟到 SSE 流内
 *  以英文 NoRoute 冒出。前端据此引导用户去设置页。
 *  注：测试注入 ctx.chatStream 时跳过——测试 registry 空壳不代表生产未配置。
 *  P2-4：区分两种失败——完全没有配置 provider vs 配置了但名字不匹配。 */
function resolveProviderForRun(
  env: ChatRunEnv,
): ChatStageResult<{ provider: string; model: string }> {
  const { ctx, c, body, sessionConfig, sessionRegistry } = env
  const provider = (body.provider as string) ?? sessionConfig.defaultProvider
  const model = (body.model as string) ?? sessionConfig.defaultModel
  if (!ctx.chatStream) {
    try {
      resolveRoute(sessionRegistry, provider, model)
    } catch {
      const configured = sessionConfig.providers
        .map((p) => p.name)
        .filter(Boolean)
        .join(', ')
      const hasAny = sessionConfig.providers.length > 0
      return {
        ok: false,
        response: apiError(
          c,
          400,
          hasAny ? 'PROVIDER_NOT_FOUND' : 'NO_PROVIDER_CONFIGURED',
          hasAny
            ? `未找到名为「${provider}」的 AI 服务。已配置：${configured}。` +
                '请检查拼写，或前往「设置 → Provider」添加该服务。'
            : `未配置可用的 AI 服务（provider: ${provider}）。请前往「设置 → Provider」添加 API 服务并测试连接`,
          {
            provider,
            configuredProviders: sessionConfig.providers.map((p) => p.name).filter(Boolean),
            ...(configured ? { hint: `已配置：${configured}` } : {}),
          },
        ),
      }
    }
    // P2-4：provider 显式声明了模型清单但请求模型不在其中 → 大概率拼写错误。
    // 未声明清单的 provider（自建网关等）接受任意模型名，不做校验。
    const providerDef = sessionConfig.providers.find(
      (p) => (p.name || (p as { _tag?: string })._tag) === provider,
    )
    const modelNames = providerDef?.models ? Object.keys(providerDef.models) : undefined
    if (modelNames && modelNames.length > 0 && !modelNames.includes(model)) {
      return {
        ok: false,
        response: apiError(
          c,
          400,
          'MODEL_NOT_FOUND',
          `provider「${provider}」没有名为「${model}」的模型。已配置模型：${modelNames.join(', ')}`,
          { provider, model, knownModels: modelNames },
        ),
      }
    }
  }
  return { ok: true, value: { provider, model } }
}

/** 阶段 7：agent SSE run——对称并发守卫（工作流运行期）+ 同步原子占位
 *  tryAcquire + 工具/agent/分段预检 + 流式执行（权限 checker、deps 组装、
 *  心跳、断连 abort、finally 善后）。 */
async function streamAgentRun(
  env: ChatRunEnv,
  userContent: MessageContent[],
  provider: string,
  model: string,
): Promise<Response> {
  const { ctx, c, sessionId, session, body, cwd, sessionConfig, sessionDefaultMode } = env
  const sessionRegistry = env.sessionRegistry
  // 对称并发守卫：该会话的工作流运行期间不允许发起普通对话（与 /workflow run
  // 侧「主 run 活跃时拒绝工作流」互斥）；工作流进度在其运行会话中可见。
  // 控制端点（abort/pause/resume）经 workflowBusyBySession 路由到工作流 run。
  if (ctx.workflowBusyBySession.has(sessionId)) {
    return apiError(
      c,
      409,
      'RUN_ACTIVE',
      '该会话有进行中的工作流执行（进度见工作流运行会话），请等待完成或中止后重试',
    )
  }

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
    // 工具解析（P1-1）：config.tools.enabled 含 '*' = 全部注册工具；空 = 无工具（fail-closed）；
    // 非空名单 = 默认集。disabled 已在 registry 层过滤，此处兜底。
    // P1 多项目：按会话项目配置解析（此前用启动目录配置）。
    // 无项目会话（projectId null/undefined）剔除项目绑定工具（kanban 等）
    const sessionHasProject = Boolean(session.projectId)
    const tools = resolveEnabledToolNames(
      ctx.toolRegistry,
      sessionConfig,
      body.tools as string[] | undefined,
    ).filter((n) => sessionHasProject || !PROJECT_BOUND_TOOLS.has(n))

    // primary agent 解析（spec: agent-frontend-switching §4.3）
    const agentName = (body.agent as string) ?? 'default'
    const agentDef = ctx.agentRegistry.get(agentName)
    if (!agentDef || agentDef.mode === 'subagent') {
      return apiError(c, 400, 'INVALID_AGENT', `Unknown or non-primary agent: ${agentName}`)
    }
    // agent def 覆盖：tools（plan 限只读）、model（可选）。
    // P1 修复：def.tools 与配置解析结果取交集——此前完全覆盖会绕过
    // config.tools.enabled 的 fail-closed 语义（禁用 bash 后切到 plan agent
    // 又静默恢复）。def 未声明 tools 时原样沿用配置解析结果。
    const resolvedTools = agentDef.tools ? agentDef.tools.filter((t) => tools.includes(t)) : tools
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
          '切换模型/工具将开始新的上下文段：此前的对话内容需要重新读取，需用户确认',
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
      // P0 心跳：长工具执行/权限确认等待期间无业务帧，心跳防前端 90s 看门狗误杀。
      const stopHeartbeat = startHeartbeat(stream)
      let doneSent = false
      let runStartedAt: number | undefined
      try {
        // M3：上轮 run 未正常结束（崩溃/重启/热更新交接，lastRun 仍为
        // running/paused）→ 把最后一条 user 消息之后的半截条目标记为
        // 「未完成轮次」：构建上下文时剔除、时间线置灰。必须先于
        // runAgent（其内部 append 新 user 消息）执行，保证边界判定正确。
        await markUnfinishedTurn(ctx.db, sessionId).catch(() => {})
        // 权限检查器：ask 权限通过 SSE 通知前端，阻塞等待确认。
        // 模式优先级：会话级覆盖（PUT /:sessionId）> 会话项目配置 defaultMode
        // > 运行时全局模式（启动默认或 PUT / 覆盖）；超时兜底 pause 时级联
        // 暂停主 run + 子 agent。
        const permissionChecker = createStreamPermissionChecker(ctx, {
          stream,
          sessionId,
          defaultMode: sessionDefaultMode,
          timeoutAction: env.permissionTimeoutAction,
          onPauseExpired: () =>
            ctx.agentManager.pauseCascade(sessionId, PERMISSION_TIMEOUT_PAUSE_REASON),
        })

        // cwd 已在斜杠拦截前解析，此处直接复用

        // 构建 agent 依赖（注入测试用 chatStream）
        const deps: LoopDeps = {
          db: ctx.db,
          llmRegistry: sessionRegistry,
          toolRegistry: ctx.toolRegistry,
          urlRegistry: ctx.urlRegistry,
          hookRunner: ctx.hookRunner,
          permission: permissionChecker,
          config: sessionConfig,
          agentRegistry: ctx.agentRegistry,
          registerChildRun: childRunBridge(ctx.agentManager),
          cwd,
          // 技能发现（system prompt ## Loaded Skills 段数据源）。
          skills: discoverSkills(cwd),
          // DAP（spec §21）：Web 宿主注入真实适配器 spawn（与 CLI 同口径）。
          debugSpawn: createDebugSpawn() as LoopDeps['debugSpawn'],
          // P3 成本护栏：会话项目配置任一轴动作为 'pause'/'abort' 时启用预算检查。
          // 具体 pause/abort 由 budgetOverageParts 按超支轴配置动作判定（abort >
          // pause），此处仅注入「启用」门禁——修 P1 双轴动作坍缩（此前 pause 分支
          // 优先，金额=abort+token=pause 等混合配置被静默降级为暂停）。
          ...(budgetGateEnabled(sessionConfig.usage) ? { budgetPause: true } : {}),
          ...(ctx.chatStream ? { chatStream: ctx.chatStream } : {}),
        }

        const agentConfig: AgentConfig = {
          provider,
          model: resolvedModel,
          tools: resolvedTools,
          plugins: sessionConfig.plugins.enabled,
          agentName,
          ...(agentDef.systemPrompt ? { agentRolePrompt: agentDef.systemPrompt } : {}),
        }

        const state = await createAgent(session, agentConfig, deps)

        // P2-3：热更新/重启后 run 重建，内存 budgetPauseTriggered 丢失——从会话
        // metadata 消费上次预算暂停标记还原（单次语义），避免用户已确认继续后
        // 又被同一超支原因二次暂停。
        const priorBudgetPause = await consumeBudgetPauseMarker(ctx.db, sessionId).catch(() => null)
        if (priorBudgetPause) state.budgetPauseTriggered = true

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
        state.lastRunStartedAt = runStartedAt

        // 填充 tryAcquire 留下的占位（原 register 语义：按 sessionId 覆盖写入）
        ctx.agentManager.register({ sessionId, state, deps })

        // workflowz 关键词检测：用户消息包含独立关键词时注入工作流通知（steering），
        // 引导模型用 task 工具批量 fan-out 做确定性多子 agent 分解。
        if (env.message && containsWorkflow(env.message)) {
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
        stopHeartbeat()
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
    // 所有权移交 SSE 回调前的任何提前返回（分段预检 409 等）或抛错都须释放
    // tryAcquire 占位，否则该会话被永久 409 锁死。
    if (!handedOff) ctx.agentManager.unregister(sessionId)
  }
}

function createChatRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // POST / — SSE 流式聊天（各阶段见上方阶段函数：body 校验 → 会话恢复 →
  // cwd/配置/信任门禁 → 斜杠分发 → 内容构建 → provider 预检 → agent SSE run）
  app.post('/', async (c) => {
    const request = await parseChatRequestBody(c)
    if (!request.ok) return request.response
    const { body, sessionId, message, images } = request.value

    const restored = await restoreChatSession(ctx, c, sessionId)
    if (!restored.ok) return restored.response
    const session = restored.value

    // 提前解析 cwd（slash 拦截与 agent 路径都需使用）
    // P1-9：worktree 失效/项目缺失 → 明确 409，不静默回退服务端 cwd。
    let cwd: string
    try {
      cwd = await resolveAgentCwd(ctx, session)
    } catch (err) {
      if (err instanceof AgentCwdError) {
        return apiError(c, 409, err.kind, err.message.replace(`${err.kind}: `, ''))
      }
      const msg = err instanceof Error ? err.message : String(err)
      return apiError(c, 500, 'CWD_RESOLVE_FAILED', msg)
    }

    const projectEnv = await resolveChatProjectEnv(ctx, c, session, cwd)
    if (!projectEnv.ok) return projectEnv.response

    const env: ChatRunEnv = {
      c,
      ctx,
      sessionId,
      session,
      body,
      message,
      images,
      cwd,
      ...projectEnv.value,
    }

    // 斜杠命令拦截（纯图片消息无文本，跳过命令解析）；未知命令回退为正常消息
    const parsed = parseSlashInput(message ?? '')
    if (parsed) {
      const slash = await dispatchSlashCommand(env, parsed)
      if (slash) return slash
    }

    const content = await buildUserContent(env)
    if (!content.ok) return content.response

    const resolved = resolveProviderForRun(env)
    if (!resolved.ok) return resolved.response

    return streamAgentRun(env, content.value, resolved.value.provider, resolved.value.model)
  })

  // 控制端点
  // P0-4：占位中的会话（tryAcquire 后、register 前）run 尚无 state 可供
  // abort/pause/resume/steer 操作——返回明确 409 而非静默 false 或崩溃。
  const runStarting = (c: Context, sessionId: string): Response | undefined =>
    ctx.agentManager.isStarting(sessionId)
      ? apiError(c, 409, 'RUN_STARTING', '该会话的对话正在启动，请稍后重试')
      : undefined

  app.post('/abort', async (c) => {
    // 畸形 JSON / 非对象 body / 缺 sessionId → 400（与其他写端点同口径）。
    // 此前裸 destructure：畸形 JSON 击穿 Hono 500，null body 在解构处
    // TypeError 500，缺 sessionId 静默回 { aborted: false }。
    const parsed = await readSessionIdBody(c)
    if (!parsed.ok) return parsed.response
    const { sessionId } = parsed
    // 工作流运行期间发起会话无主 run：中止请求路由到实际的工作流 run。
    const busyWorkflowId = ctx.workflowBusyBySession.get(sessionId)
    if (busyWorkflowId) {
      return c.json({ aborted: ctx.agentManager.abort(busyWorkflowId) })
    }
    return runStarting(c, sessionId) ?? c.json({ aborted: ctx.agentManager.abort(sessionId) })
  })

  app.post('/pause', async (c) => {
    const parsed = await readSessionIdBody(c)
    if (!parsed.ok) return parsed.response
    const { sessionId } = parsed
    // 级联子 run（P1：子 agent 现已注册，暂停主 run 必须一并暂停——
    // 否则后台子 agent 在用户认为「已暂停」时继续执行）。
    const busyWorkflowId = ctx.workflowBusyBySession.get(sessionId)
    const targetId = busyWorkflowId ?? sessionId
    if (!busyWorkflowId && runStarting(c, sessionId)) return runStarting(c, sessionId)
    const paused = ctx.agentManager.pauseCascade(targetId)
    return c.json({ paused })
  })

  app.post('/resume', async (c) => {
    const parsed = await readSessionIdBody(c)
    if (!parsed.ok) return parsed.response
    const { sessionId } = parsed
    // 权限超时暂停工作流后，发起会话展示「恢复」按钮——路由到工作流 run 真正恢复。
    // 级联恢复子 run：暂停时子 run 一并暂停，仅恢复主 run 会让父的工具批次
    // 永远等待已暂停的子 agent（死锁）。
    const busyWorkflowId = ctx.workflowBusyBySession.get(sessionId)
    const targetId = busyWorkflowId ?? sessionId
    if (!busyWorkflowId && runStarting(c, sessionId)) return runStarting(c, sessionId)
    const resumed = ctx.agentManager.resumeCascade(targetId)
    return c.json({ resumed })
  })

  app.post('/steer', async (c) => {
    const parsed = await readSessionIdBody(c)
    if (!parsed.ok) return parsed.response
    const { sessionId, body } = parsed
    const starting = runStarting(c, sessionId)
    if (starting) return starting
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message) return c.json({ steered: false })
    // P1 工作流路由：工作流运行期间 steer 目标为实际的 workflow run
    //（此前 steer 恒 false、指令静默丢失，用户以为已生效）。
    const busyWorkflowId = ctx.workflowBusyBySession.get(sessionId)
    const steered = ctx.agentManager.steer(busyWorkflowId ?? sessionId, message)
    // P0 闭环：steering 持久化为会话条目——用户运行中输入追加指令曾是内存瞬态，
    // 刷新后彻底丢失；现在与消息同样入史（context 重建时作为 system 消息注入，
    // 时间线经 /messages 渲染为 user steering 块）。
    if (steered) {
      await insertEntry(ctx.db, {
        sessionId,
        tag: 'steering',
        content: { text: message },
      }).catch(() => {
        // 持久化失败不阻塞本轮生效（指令已进入 run 队列）
      })
    }
    return c.json({ steered })
  })

  return app
}

export { createChatRoute }
