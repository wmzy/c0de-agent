import { Hono } from 'hono'
import { getSession } from '../../session/session.js'
import type { InstallMethod } from '../../update/index.js'
import {
  getCurrentVersion,
  manualInstallCommand,
  performHandoff,
  performInstall,
  serializeSessions,
} from '../../update/index.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/**
 * GET /api/update — 返回后台调度器缓存的版本检查结果（spec §18.1）。
 * 路由本身不触发 npm registry 请求；调度器周期性 checkNow 写入缓存，
 * 路由读缓存（避免每个前端轮询都打外网）。
 *
 * POST /api/update/apply — 手动触发热更新（spec §18.2），P0 修复后顺序：
 *   1. checkNow 确认有更新；
 *   2. performInstall（仅安装新版本）——失败时**尚未暂停任何会话**，
 *      直接返回可操作错误（409 + 手动更新命令），用户工作零损失；
 *   3. 安装成功 → pauseAll 暂停活跃 run 至安全点（原子操作完成）；
 *   4. serializeSessions → performHandoff（写快照 + spawn 新实例）；
 *   5. spawn 失败 → resumeAll 回滚暂停的会话，返回明确错误。
 *
 * 旧实例通过 handoff 端点优雅退出，新实例 restore 快照并接管端口。
 * 响应立即返回（不阻塞 spawn），实际接管由 handoff IPC 异步完成。
 * dev（vite）模式无 handoff server，返回 409——热更新仅在独立 serve 进程可用。
 */
function createUpdateRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    // 热更新影响面（P2-11）：apply 前由前端确认框逐项展示受影响对象。
    // 顶层 run（主 agent）+ 终端数；子 agent 归父会话，不重复列出。
    const active = ctx.agentManager.listActive()
    const topRuns = active.filter((r) => !r.parentSessionId)
    const runs: Array<{ sessionId: string; title: string; agentType?: string }> = []
    for (const r of topRuns) {
      let title = r.sessionId.slice(0, 8)
      try {
        const session = await getSession(ctx.db, r.sessionId)
        if (session) title = session.title
      } catch {
        // 会话查询失败：回退 id 前缀展示
      }
      runs.push({
        sessionId: r.sessionId,
        title,
        ...(r.agentType ? { agentType: r.agentType } : {}),
      })
    }
    const impact = { runs, terminalCount: ctx.ptyManager.list().length }

    // P2-8：update.enabled=false 时无 handoff server，apply 必然 409。
    // 不再触发 checkNow，也不返回 hasUpdate，避免横幅出现一个点了必失败的应用按钮。
    if (ctx.config.update.enabled === false) {
      const v = getCurrentVersion()
      return c.json({
        hasUpdate: false,
        disabled: true,
        currentVersion: v,
        latestVersion: v,
        impact,
      })
    }
    const cached = ctx.updateScheduler.getLastResult()
    if (cached) return c.json({ ...cached, impact })
    // 无缓存（首次启动延迟未到）：同步触发一次，避免前端首屏空。
    // 不 await——保持 GET 语义非阻塞；前端下次轮询拿到结果。
    void ctx.updateScheduler.checkNow()
    const v = getCurrentVersion()
    return c.json({
      hasUpdate: false,
      currentVersion: v,
      latestVersion: v,
      impact,
    })
  })

  app.post('/apply', async (c) => {
    if (!ctx.handoff) {
      return apiError(
        c,
        409,
        'HOT_UPDATE_UNAVAILABLE',
        '热更新仅在独立 serve 进程可用（dev 模式请手动更新）',
      )
    }
    const result = await ctx.updateScheduler.checkNow()
    if (!result.hasUpdate) {
      return apiError(c, 409, 'NO_UPDATE', '已是最新版本，无需热更新')
    }

    // P0 修复：install 先行。失败（网络/权限/unknown 安装方式）时未触碰任何
    // 会话状态，直接返回可操作错误——旧流程先 pause 后 install，失败时
    // 已暂停/强杀的会话无回滚路径。
    const install = await performInstall({})
    if (install._tag === 'install_failed') {
      return apiError(c, 409, 'INSTALL_FAILED', install.error, {
        command: manualInstallCommand('c0de-agent'),
      })
    }
    if (install._tag === 'manual_install_required') {
      return apiError(c, 409, 'MANUAL_UPDATE_REQUIRED', install.error, {
        command: install.command,
      })
    }
    const method: InstallMethod = { kind: install.installMethod as 'npm' | 'pnpm' }

    // 安装已成功 → 暂停所有活跃 run，等其到达安全暂停点（原子操作完成）。
    // 注意：暂停不是「可恢复快照」——新实例只有 DB 状态、无内存 agent run，
    // 进行中的对话会以 interrupted 呈现，用户重发上一条消息即可继续（幂等
    // 检查跳过重复 append）。工具副作用不回滚。
    const pauseTimeoutMs = ctx.config.update.pauseTimeoutMs ?? 30_000
    const pauseResult = await ctx.agentManager.pauseAll(pauseTimeoutMs)

    const snapshot = await serializeSessions(ctx.db, ctx.config)
    const r = await performHandoff(snapshot, method, {
      handoffPort: ctx.handoff.port,
      port: ctx.port,
      // P2-16：传当前 bootstrap（轮换后 ctx.authToken 可能已过期）；
      // 旧实例 handoff 端点经 verifyHandoff 接受当前/历史 bootstrap 与设备 token。
      authToken: ctx.authManager?.bootstrap ?? ctx.authToken,
    })
    if (r._tag !== 'success') {
      // P0 回滚：spawn 失败（含程序文件未就绪等）→ 恢复被暂停的会话。
      // forcedAbort 的无法恢复（已中止），但这是超时兜底，属可接受损失。
      for (const id of pauseResult.pausedIds) {
        ctx.agentManager.resume(id)
      }
      if (r._tag === 'manual_install_required') {
        return apiError(c, 409, 'MANUAL_UPDATE_REQUIRED', r.error, {
          command: r.command,
          snapshotPath: r.snapshotPath,
          resumedSessions: pauseResult.pausedIds.length,
        })
      }
      return apiError(c, 500, 'HOT_UPDATE_FAILED', `${r._tag}: ${r.error}`, {
        resumedSessions: pauseResult.pausedIds.length,
      })
    }
    return c.json({
      ok: true,
      snapshotPath: r.snapshotPath,
      latestVersion: result.latestVersion,
      installMethod: r.installMethod,
      pausedSessions: pauseResult.paused,
      forcedAbort: pauseResult.forcedAbort,
    })
  })

  return app
}

export { createUpdateRoute }
