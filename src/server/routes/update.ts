import { Hono } from 'hono'
import { getCurrentVersion, performHotUpdate, serializeSessions } from '../../update/index.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/**
 * GET /api/update — 返回后台调度器缓存的版本检查结果（spec §18.1）。
 * 路由本身不触发 npm registry 请求；调度器周期性 checkNow 写入缓存，
 * 路由读缓存（避免每个前端轮询都打外网）。
 *
 * POST /api/update/apply — 手动触发热更新（spec §18.2）：
 *   序列化当前会话 → performHotUpdate（npm install -g + spawn 新实例 + handoffPort）。
 *   旧实例通过 handoff 端点优雅退出，新实例 restore 快照并接管端口。
 *   响应立即返回（不阻塞 spawn），实际接管由 handoff IPC 异步完成。
 *   dev（vite）模式无 handoff server，返回 409——热更新仅在独立 serve 进程可用。
 */
function createUpdateRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    const cached = ctx.updateScheduler.getLastResult()
    if (cached) return c.json(cached)
    // 无缓存（首次启动延迟未到）：同步触发一次，避免前端首屏空。
    // 不 await——保持 GET 语义非阻塞；前端下次轮询拿到结果。
    void ctx.updateScheduler.checkNow()
    const v = getCurrentVersion()
    return c.json({
      hasUpdate: false,
      currentVersion: v,
      latestVersion: v,
    })
  })

  app.post('/apply', async (c) => {
    if (!ctx.handoff) {
      return apiError(c, 409, 'HOT_UPDATE_UNAVAILABLE', '热更新仅在独立 serve 进程可用（dev 模式请手动更新）')
    }
    const result = await ctx.updateScheduler.checkNow()
    if (!result.hasUpdate) {
      return apiError(c, 409, 'NO_UPDATE', '已是最新版本，无需热更新')
    }
    const snapshot = await serializeSessions(ctx.db, ctx.config)
    const r = await performHotUpdate(snapshot, {
      handoffPort: ctx.handoff.port,
      port: ctx.port,
      authToken: ctx.authToken,
    })
    if (r._tag === 'success') {
      return c.json({
        ok: true,
        snapshotPath: r.snapshotPath,
        latestVersion: result.latestVersion,
      })
    }
    return apiError(c, 500, 'HOT_UPDATE_FAILED', `${r._tag}: ${'error' in r ? r.error : 'unknown'}`)
  })

  return app
}

export { createUpdateRoute }
