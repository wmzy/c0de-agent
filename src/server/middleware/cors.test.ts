import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createCORSMiddleware, isLocalOrigin } from './cors.js'

function appWith(allowedOrigins?: string[]) {
  const app = new Hono()
  app.use('*', createCORSMiddleware({ allowedOrigins }))
  app.get('/api/x', (c) => c.json({ ok: true }))
  return app
}

describe('isLocalOrigin', () => {
  it('本机回环任意端口 → true', () => {
    expect(isLocalOrigin('http://localhost:3000')).toBe(true)
    expect(isLocalOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isLocalOrigin('https://[::1]:8080')).toBe(true)
    expect(isLocalOrigin('http://localhost')).toBe(true)
  })

  it('file:// 与扩展协议 → true（PWA/扩展场景）', () => {
    expect(isLocalOrigin('file://')).toBe(true)
    expect(isLocalOrigin('chrome-extension://abc')).toBe(true)
    expect(isLocalOrigin('moz-extension://def')).toBe(true)
  })

  it("'null' origin → true（file/沙箱）", () => {
    expect(isLocalOrigin('null')).toBe(true)
  })

  it('外部域名 → false', () => {
    expect(isLocalOrigin('https://evil.com')).toBe(false)
    expect(isLocalOrigin('http://attacker.example:3000')).toBe(false)
  })

  it('空串 → false', () => {
    expect(isLocalOrigin('')).toBe(false)
  })

  it('仿冒本地域名的子域 → false', () => {
    expect(isLocalOrigin('http://localhost.evil.com')).toBe(false)
    expect(isLocalOrigin('http://evil.com/localhost')).toBe(false)
  })
})

describe('createCORSMiddleware', () => {
  it('本地 origin → 回显 Allow-Origin', async () => {
    const res = await appWith().request('/api/x', {
      headers: { Origin: 'http://localhost:5173' },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    expect(res.headers.get('Vary')).toBe('Origin')
  })

  it('外部 origin → 不回显 Allow-Origin（拒绝跨域读）', async () => {
    const res = await appWith().request('/api/x', {
      headers: { Origin: 'https://evil.com' },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('同源请求（无 Origin 头）→ 不设 Allow-Origin', async () => {
    const res = await appWith().request('/api/x')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(await res.json()).toEqual({ ok: true })
  })

  it('OPTIONS 预检 → 204 + 预检头', async () => {
    const res = await appWith().request('/api/x', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET')
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
  })

  it('额外配置的 allowedOrigins → 允许', async () => {
    const res = await appWith(['https://my-team.example']).request('/api/x', {
      headers: { Origin: 'https://my-team.example' },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://my-team.example')
  })
})
