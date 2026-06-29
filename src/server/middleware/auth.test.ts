import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createAuthMiddleware } from './auth.js'

function appWith(token: string | undefined) {
  const app = new Hono()
  app.use('/api/*', createAuthMiddleware(token))
  app.get('/api/x', (c) => c.json({ ok: true }))
  app.get('/public', (c) => c.json({ ok: true }))
  return app
}

describe('createAuthMiddleware', () => {
  it('未配置 token → 放行（本地开发）', async () => {
    const res = await appWith(undefined).request('/api/x')
    expect(res.status).toBe(200)
  })

  it('空串 token → 放行', async () => {
    const res = await appWith('').request('/api/x')
    expect(res.status).toBe(200)
  })

  it('正确 Bearer token → 放行', async () => {
    const res = await appWith('secret-token').request('/api/x', {
      headers: { Authorization: 'Bearer secret-token' },
    })
    expect(res.status).toBe(200)
  })

  it('缺失 Authorization → 401', async () => {
    const res = await appWith('secret-token').request('/api/x')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('错误 token → 401', async () => {
    const res = await appWith('secret-token').request('/api/x', {
      headers: { Authorization: 'Bearer wrong' },
    })
    expect(res.status).toBe(401)
  })

  it('非 Bearer scheme → 401', async () => {
    const res = await appWith('secret-token').request('/api/x', {
      headers: { Authorization: 'Basic secret-token' },
    })
    expect(res.status).toBe(401)
  })

  it('非 /api 路径不走 auth 中间件 → 放行', async () => {
    const res = await appWith('secret-token').request('/public')
    expect(res.status).toBe(200)
  })

  it('publicPaths 放行（如健康检查）', async () => {
    const app = new Hono()
    app.use('/api/*', createAuthMiddleware('secret-token', { publicPaths: ['/api/health'] }))
    app.get('/api/health', (c) => c.json({ ok: true }))
    app.get('/api/x', (c) => c.json({ ok: true }))
    const healthRes = await app.request('/api/health')
    expect(healthRes.status).toBe(200)
    const xRes = await app.request('/api/x')
    expect(xRes.status).toBe(401)
  })
})
