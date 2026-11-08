import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { sessions } from '../../db/schema.js'
import { isUuid } from '../../shared/utils/string.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'
import { readJsonObject } from '../util/json-body.js'
import { getLiveSessionOr404 } from './chat.js'

/** GET/PUT /api/permissions — 授权模式（default 逐个确认 / auto 自动放行 ask 工具）。
 *  - 根路径：全局默认模式（启动时取 config.permission.defaultMode；
 *    PUT / 持久化到 global 作用域 config，重启后仍生效）
 *  - /:sessionId：会话级覆盖（P1-5 按会话隔离 auto 高风险状态）。
 *    P2：会话级覆盖持久化到 session.metadata.permissionMode，重启后经 GET 或
 *    chat 路由懒加载恢复——此前仅内存 Map，重启静默回退 default，用户困惑。
 *  - /:sessionId/always-allow：会话级「始终允许」工具白名单（P2 权限疲劳治理），
 *    持久化到 session.metadata.alwaysAllow，checker 经 getter 实时读取。
 */

/** 读取会话 metadata 行（单一读取器）。行不存在与查询失败统一返回 null——
 *  两类失败在调用方都走同一条回退路径（覆盖模式回退默认、白名单回退空表、
 *  持久化跳过），无需区分。 */
async function readSessionMetadata(
  ctx: ServerContext,
  sessionId: string,
): Promise<{ metadata: unknown } | null> {
  try {
    const [row] = await ctx.db.db
      .select({ metadata: sessions.metadata })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
    return row ?? null
  } catch {
    return null
  }
}

/** 懒加载会话级权限覆盖到内存 Map（幂等；无有效覆盖则不写入，读取时回退默认）。
 *  可传入已读取的 metadata 行避免重复查询（见 GET /:sessionId）。 */
async function ensureSessionModeLoaded(
  ctx: ServerContext,
  sessionId: string,
  metaRow?: { metadata: unknown } | null,
): Promise<void> {
  if (ctx.sessionPermissionModes.has(sessionId)) return
  const row = metaRow !== undefined ? metaRow : await readSessionMetadata(ctx, sessionId)
  const mode = (row?.metadata as { permissionMode?: 'auto' | 'default' } | undefined)
    ?.permissionMode
  if (mode === 'auto' || mode === 'default') {
    ctx.sessionPermissionModes.set(sessionId, mode)
  }
}

/** 懒加载会话级始终允许白名单到内存 Map（幂等；失败/无记录回退空列表）。 */
async function ensureSessionAllowLoaded(
  ctx: ServerContext,
  sessionId: string,
  metaRow?: { metadata: unknown } | null,
): Promise<void> {
  if (ctx.sessionAlwaysAllow.has(sessionId)) return
  const row = metaRow !== undefined ? metaRow : await readSessionMetadata(ctx, sessionId)
  const list = (row?.metadata as { alwaysAllow?: unknown } | undefined)?.alwaysAllow
  ctx.sessionAlwaysAllow.set(
    sessionId,
    Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : [],
  )
}

/** 持久化会话 metadata（read-modify-write，读取走共享 reader；失败不致命：
 *  内存态本次运行仍生效）。 */
async function persistSessionMetadata(
  ctx: ServerContext,
  sessionId: string,
  mutate: (meta: Record<string, unknown>) => void,
): Promise<void> {
  const row = await readSessionMetadata(ctx, sessionId)
  if (!row) return
  const meta = { ...((row.metadata ?? {}) as Record<string, unknown>) }
  mutate(meta)
  try {
    await ctx.db.db.update(sessions).set({ metadata: meta }).where(eq(sessions.id, sessionId))
  } catch {
    // 持久化失败不致命
  }
}

function createPermissionsRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 路径参数 sessionId 的统一守卫：非 UUID 直接 404；UUID 但会话不存在/在
  // 回收站（deletedAt）同样 404（DB 访问折进 middleware，与 kanban.ts 的
  // guardProject 同型）。「格式非法」与「会话不存在」同属资源不存在，统一 404。
  //
  // 格式守卫此前缺失：PUT /:sessionId 的 getSession 把非 UUID 直接送进 drizzle
  // 参数化查询，PG 侧抛 22P02（invalid input syntax for type uuid），Hono 兜成
  // 500 并把 SQL 错误细节回给客户端——与 session/kanban/todo 路由已修的
  // 同型缺陷。
  //
  // 存在性守卫（P3-11）：不存在/回收站会话返回成功会谎报「已生效」——
  // 设置 auto 覆盖、写入白名单均污染内存 Map 而无真实会话承载；返回全局
  // 默认模式也会冒充「该会话的模式」，调用方无法区分「无覆盖」与「会话不存在」。
  // /:sessionId/pending 只读内存 permissionStore（不触 DB），不受守卫约束。
  //
  // 完整口径（非 UUID / 不存在 / 已进回收站 → 404）收敛到 getLiveSessionOr404：
  // 非 UUID 由其内部 try/catch 统一吸收（getSession 抛 22P02 → 404），deletedAt
  // 判定即 requireLive 默认语义，与会话各写端点同源。
  const guardSessionId = async (
    c: Context,
    next: () => Promise<void>,
  ): Promise<Response | undefined> => {
    const sessionId = c.req.param('sessionId') ?? ''
    if (!isUuid(sessionId)) {
      return apiError(c, 404, 'NOT_FOUND', '会话不存在或已删除')
    }
    const live = await getLiveSessionOr404(ctx, c, sessionId, {
      notFoundMessage: '会话不存在或已删除',
      deletedMessage: '会话不存在或已删除',
    })
    if (!live.ok) return live.response
    await next()
  }
  app.use('/:sessionId', guardSessionId)
  app.use('/:sessionId/always-allow', guardSessionId)
  app.use('/:sessionId/always-allow/*', guardSessionId)

  // GET / — 默认授权模式
  app.get('/', (c) => {
    return c.json({ mode: ctx.permissionMode })
  })

  // PUT / — 设置全局默认授权模式（P1-4：持久化到 global 作用域 config）。
  // 此前仅本次运行生效、重启静默回退，与同款控件在会话页的持久化语义相悖。
  app.put('/', async (c) => {
    const parsed = await readJsonObject(c)
    if (!parsed.ok) return parsed.response
    const mode = parsed.body.mode
    if (mode !== 'default' && mode !== 'auto') {
      return apiError(c, 400, 'INVALID_MODE', "mode 必须是 'default' 或 'auto'")
    }
    ctx.permissionMode = mode
    try {
      const { applyScopedPatch, loadConfigScopes, saveConfigScoped } = await import(
        '../../core/config.js'
      )
      const scopes = loadConfigScopes(ctx.cwd)
      const next = applyScopedPatch(scopes.global ?? {}, {
        permission: { defaultMode: mode },
      })
      await saveConfigScoped('global', ctx.cwd, next)
    } catch {
      // 持久化失败不致命：本次运行仍生效（与 /:sessionId 覆盖的降级语义一致）
    }
    return c.json({ mode: ctx.permissionMode })
  })

  // GET /:sessionId — 会话实际生效模式（覆盖优先，回退默认）+ 始终允许白名单
  app.get('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    // 一次读取同时喂 mode 与 alwaysAllow 两个懒加载（此前背靠背两次相同查询）
    const metaRow = await readSessionMetadata(ctx, sessionId)
    await ensureSessionModeLoaded(ctx, sessionId, metaRow)
    await ensureSessionAllowLoaded(ctx, sessionId, metaRow)
    return c.json({
      mode: ctx.sessionPermissionModes.get(sessionId) ?? ctx.permissionMode,
      alwaysAllow: ctx.sessionAlwaysAllow.get(sessionId) ?? [],
    })
  })

  // PUT /:sessionId — 设置会话级覆盖；不传 mode 则清除覆盖。P2：落库持久化。
  app.put('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const parsed = await readJsonObject(c)
    if (!parsed.ok) return parsed.response
    const mode = parsed.body.mode
    if (mode !== undefined && mode !== 'default' && mode !== 'auto') {
      return apiError(c, 400, 'INVALID_MODE', "mode 必须是 'default' 或 'auto'")
    }
    if (mode === undefined) {
      ctx.sessionPermissionModes.delete(sessionId)
    } else {
      ctx.sessionPermissionModes.set(sessionId, mode)
    }
    // 持久化：写 session.metadata.permissionMode（无该字段时删除，回退全局默认）。
    // 失败仅影响重启后的恢复，本次运行的 Map 状态仍生效。
    await persistSessionMetadata(ctx, sessionId, (meta) => {
      if (mode === undefined) {
        delete meta.permissionMode
      } else {
        meta.permissionMode = mode
      }
    })
    return c.json({ mode: ctx.sessionPermissionModes.get(sessionId) ?? ctx.permissionMode })
  })

  // GET /:sessionId/pending — 查询会话当前挂起的权限请求（P1：挂起期间切换页面/
  // 刷新后前端重挂确认弹窗，恢复被阻塞 run 的可操作路径。无挂起返回 pending: null。
  app.get('/:sessionId/pending', (c) => {
    const sessionId = c.req.param('sessionId')
    const pending = ctx.permissionStore.pendingForSession(sessionId)
    return c.json({ pending })
  })

  // POST /:sessionId/always-allow — 追加工具到会话白名单（幂等）
  app.post('/:sessionId/always-allow', async (c) => {
    const sessionId = c.req.param('sessionId')
    const parsed = await readJsonObject(c)
    if (!parsed.ok) return parsed.response
    const tool = parsed.body.tool
    if (typeof tool !== 'string' || tool.length === 0) {
      return apiError(c, 400, 'BAD_REQUEST', 'tool is required')
    }
    await ensureSessionAllowLoaded(ctx, sessionId)
    const list = ctx.sessionAlwaysAllow.get(sessionId) ?? []
    if (!list.includes(tool)) list.push(tool)
    ctx.sessionAlwaysAllow.set(sessionId, list)
    await persistSessionMetadata(ctx, sessionId, (meta) => {
      meta.alwaysAllow = list
    })
    return c.json({ alwaysAllow: list })
  })

  // DELETE /:sessionId/always-allow/:tool — 从会话白名单移除
  app.delete('/:sessionId/always-allow/:tool', async (c) => {
    const sessionId = c.req.param('sessionId')
    const tool = c.req.param('tool')
    await ensureSessionAllowLoaded(ctx, sessionId)
    const list = (ctx.sessionAlwaysAllow.get(sessionId) ?? []).filter((t) => t !== tool)
    ctx.sessionAlwaysAllow.set(sessionId, list)
    await persistSessionMetadata(ctx, sessionId, (meta) => {
      if (list.length === 0) delete meta.alwaysAllow
      else meta.alwaysAllow = list
    })
    return c.json({ alwaysAllow: list })
  })

  return app
}

export { createPermissionsRoute }
