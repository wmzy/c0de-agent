// src/server/routes/auth.ts
// P2-16：认证引导 + 设备配对审批端点。
//
// 公开端点（未认证，中间件 publicPaths 放行）：
//   POST /api/auth/register          首设备注册：凭 bootstrap token 换发设备 token
//   POST /api/auth/pairing/request   新设备发起配对：返回 pairingId + 6 位配对码
//   GET  /api/auth/pairing/status?pairingId=xxx  新设备轮询审批结果
//
// 需认证端点（已授权设备调用）：
//   GET  /api/auth/pairing           列出待审批配对
//   POST /api/auth/pairing/approve   审批通过（签发设备 token）
//   POST /api/auth/pairing/deny      拒绝配对
//   GET  /api/auth/devices           列出已授权设备
//   DELETE /api/auth/devices/:id     撤销设备（立即生效）

import { type Context, Hono } from 'hono'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/** 尽力而为的请求来源：x-forwarded-for 首跳（反代场景），否则视为本地回环。仅展示/软限流。 */
function requestSource(c: Context): string {
  const fwd = c.req.header('x-forwarded-for')
  if (fwd) {
    const first = fwd.split(',')[0]?.trim()
    if (first) return first
  }
  return 'local'
}

function createAuthRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 首设备注册：凭 bootstrap token（URL ?token=）换发设备 token，bootstrap 随即轮换失效。
  app.post('/register', async (c) => {
    if (!ctx.authManager) {
      return apiError(c, 400, 'AUTH_DISABLED', '认证未启用')
    }
    const body = (await c.req.json().catch(() => ({}))) as { token?: string; deviceName?: string }
    if (!body.token) {
      return apiError(c, 400, 'BAD_REQUEST', 'token is required')
    }
    const result = await ctx.authManager.registerFirstDevice(body.token, body.deviceName ?? '设备')
    if (!result.ok) {
      // 区分失败原因给正确的恢复指引：链接过期 → 重启 serve 换新链接；
      // 已有设备 → 走配对审批；两者补救动作完全不同，不得混用同一文案。
      if (result.reason === 'ttl_expired') {
        return apiError(
          c,
          403,
          'BOOTSTRAP_EXPIRED',
          '注册链接已过期（超过安全窗口未使用）。请重启 c0de serve——无已注册设备时' +
            '重启会重新生成注册链接，打开启动日志中打印的新 URL 完成首次注册。',
        )
      }
      if (result.reason === 'devices_exist') {
        return apiError(
          c,
          403,
          'BOOTSTRAP_CONSUMED',
          'bootstrap token 已失效（已有设备注册）。请在新设备发起配对，由已授权设备审批。',
        )
      }
      if (result.reason === 'invalid_bootstrap') {
        return apiError(c, 403, 'BOOTSTRAP_INVALID', 'bootstrap token 无效。')
      }
      return apiError(c, 403, 'STATIC_TOKEN_MODE', '静态 token 模式不支持设备注册。')
    }
    // P1-3：回传注册成功的设备名，前端展示一次性确认（用户可核对注册的是否自己）。
    return c.json({ deviceToken: result.deviceToken, deviceName: body.deviceName ?? '设备' })
  })

  // 新设备发起配对请求（公开）。
  app.post('/pairing/request', async (c) => {
    if (!ctx.authManager) {
      return apiError(c, 400, 'AUTH_DISABLED', '认证未启用')
    }
    const body = (await c.req.json().catch(() => ({}))) as { deviceName?: string }
    const result = ctx.authManager.requestPairing(body.deviceName ?? '新设备', requestSource(c))
    if (!result) {
      return apiError(c, 429, 'PAIRING_LIMIT', '待审批的配对请求过多，请稍后再试')
    }
    // L3：零已授权设备时配对审批不可能完成（无人可批准）——前端据此展示
    // 恢复指引（重启 serve 重新生成 bootstrap 注册链接）而非干等审批。
    return c.json({
      ...result,
      hasAuthorizedDevices: ctx.authManager.listDevices().length > 0,
    })
  })

  // 新设备轮询配对审批结果（公开）。
  app.get('/pairing/status', (c) => {
    if (!ctx.authManager) {
      return apiError(c, 400, 'AUTH_DISABLED', '认证未启用')
    }
    const pairingId = c.req.query('pairingId') ?? ''
    if (!pairingId) return apiError(c, 400, 'BAD_REQUEST', 'pairingId is required')
    const status = ctx.authManager.pairingStatus(pairingId)
    if (status.status === 'not_found') {
      return apiError(c, 404, 'PAIRING_NOT_FOUND', '配对请求不存在或已过期')
    }
    return c.json(status)
  })

  // 列出待审批配对（需认证）。
  app.get('/pairing', (c) => {
    if (!ctx.authManager) {
      return apiError(c, 400, 'AUTH_DISABLED', '认证未启用')
    }
    return c.json({ pairings: ctx.authManager.listPairings() })
  })

  // 审批通过（需认证）。
  app.post('/pairing/approve', async (c) => {
    if (!ctx.authManager) {
      return apiError(c, 400, 'AUTH_DISABLED', '认证未启用')
    }
    const body = (await c.req.json().catch(() => ({}))) as { pairingId?: string }
    if (!body.pairingId) return apiError(c, 400, 'BAD_REQUEST', 'pairingId is required')
    const ok = ctx.authManager.approvePairing(body.pairingId)
    if (!ok) return apiError(c, 404, 'PAIRING_NOT_FOUND', '配对请求不存在或已过期')
    return c.json({ ok: true })
  })

  // 拒绝配对（需认证）。
  app.post('/pairing/deny', async (c) => {
    if (!ctx.authManager) {
      return apiError(c, 400, 'AUTH_DISABLED', '认证未启用')
    }
    const body = (await c.req.json().catch(() => ({}))) as { pairingId?: string }
    if (!body.pairingId) return apiError(c, 400, 'BAD_REQUEST', 'pairingId is required')
    const ok = ctx.authManager.denyPairing(body.pairingId)
    if (!ok) return apiError(c, 404, 'PAIRING_NOT_FOUND', '配对请求不存在或已过期')
    return c.json({ ok: true })
  })

  // 列出已授权设备（需认证；设置页「已授权设备」面板）。
  app.get('/devices', (c) => {
    if (!ctx.authManager) {
      return apiError(c, 400, 'AUTH_DISABLED', '认证未启用')
    }
    return c.json({ devices: ctx.authManager.listDevices() })
  })

  // 撤销设备（需认证）。撤销唯一设备后如需重新注册首设备，请运行 c0de auth reset。
  app.delete('/devices/:id', async (c) => {
    if (!ctx.authManager) {
      return apiError(c, 400, 'AUTH_DISABLED', '认证未启用')
    }
    const ok = ctx.authManager.revokeDevice(c.req.param('id'))
    if (!ok) return apiError(c, 404, 'NOT_FOUND', 'Device not found')
    return c.json({ ok: true })
  })

  return app
}

export { createAuthRoute }
