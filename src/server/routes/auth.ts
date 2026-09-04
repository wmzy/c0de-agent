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

import { Hono } from 'hono'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

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
    const deviceToken = await ctx.authManager.registerFirstDevice(
      body.token,
      body.deviceName ?? '设备',
    )
    if (!deviceToken) {
      // bootstrap 已失效/已注册过设备 → 引导走配对审批
      return apiError(
        c,
        403,
        'BOOTSTRAP_CONSUMED',
        'bootstrap token 已失效（已有设备注册）。请在新设备发起配对，由已授权设备审批。',
      )
    }
    return c.json({ deviceToken })
  })

  // 新设备发起配对请求（公开）。
  app.post('/pairing/request', async (c) => {
    if (!ctx.authManager) {
      return apiError(c, 400, 'AUTH_DISABLED', '认证未启用')
    }
    const body = (await c.req.json().catch(() => ({}))) as { deviceName?: string }
    const result = ctx.authManager.requestPairing(body.deviceName ?? '新设备')
    if (!result) {
      return apiError(c, 429, 'PAIRING_LIMIT', '待审批的配对请求过多，请稍后再试')
    }
    return c.json(result)
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

  return app
}

export { createAuthRoute }
