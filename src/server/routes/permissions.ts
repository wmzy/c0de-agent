import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { sessions } from '../../db/schema.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/** GET/PUT /api/permissions — 授权模式（default 逐个确认 / auto 自动放行 ask 工具）。
 *  - 根路径：默认模式（全局，启动时取 config.permission.defaultMode）
 *  - /:sessionId：会话级覆盖（P1-5 按会话隔离 auto 高风险状态）。
 *    P2：会话级覆盖持久化到 session.metadata.permissionMode，重启后经 GET 或
 *    chat 路由懒加载恢复——此前仅内存 Map，重启静默回退 default，用户困惑。
 */

/** 懒加载会话级权限覆盖到内存 Map（幂等；查询失败静默回退默认语义）。 */
async function ensureSessionModeLoaded(ctx: ServerContext, sessionId: string): Promise<void> {
  if (ctx.sessionPermissionModes.has(sessionId)) return
  try {
    const [row] = await ctx.db.db
      .select({ metadata: sessions.metadata })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
    const mode = (row?.metadata as { permissionMode?: 'auto' | 'default' } | undefined)
      ?.permissionMode
    if (mode === 'auto' || mode === 'default') {
      ctx.sessionPermissionModes.set(sessionId, mode)
    }
  } catch {
    // 会话不存在/查询失败：回退默认模式
  }
}

function createPermissionsRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET / — 默认授权模式
  app.get('/', (c) => {
    return c.json({ mode: ctx.permissionMode })
  })

  // PUT / — 运行时切换默认模式（仅本次运行生效，不回写 config）
  app.put('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { mode?: unknown } | null
    const mode = body?.mode
    if (mode !== 'default' && mode !== 'auto') {
      return apiError(c, 400, 'INVALID_MODE', "mode 必须是 'default' 或 'auto'")
    }
    ctx.permissionMode = mode
    return c.json({ mode: ctx.permissionMode })
  })

  // GET /:sessionId — 会话实际生效模式（覆盖优先，回退默认）
  app.get('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    await ensureSessionModeLoaded(ctx, sessionId)
    return c.json({ mode: ctx.sessionPermissionModes.get(sessionId) ?? ctx.permissionMode })
  })

  // PUT /:sessionId — 设置会话级覆盖；不传 mode 则清除覆盖。P2：落库持久化。
  app.put('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const body = (await c.req.json().catch(() => null)) as { mode?: unknown } | null
    const mode = body?.mode
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
    try {
      const [row] = await ctx.db.db
        .select({ metadata: sessions.metadata })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
      if (row) {
        const meta = { ...(row.metadata ?? {}) } as Record<string, unknown>
        if (mode === undefined) {
          delete meta.permissionMode
        } else {
          meta.permissionMode = mode
        }
        await ctx.db.db.update(sessions).set({ metadata: meta }).where(eq(sessions.id, sessionId))
      }
    } catch {
      // 持久化失败不致命（内存态本次运行生效）
    }
    return c.json({ mode: ctx.sessionPermissionModes.get(sessionId) ?? ctx.permissionMode })
  })

  return app
}

export { createPermissionsRoute }
