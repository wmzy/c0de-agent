import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from './api.js'

describe('apiRequest', () => {
  afterEach(() => vi.restoreAllMocks())

  it('返回解析后的 JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      }),
    )
    const result = await apiRequest('/api/health')
    expect(result).toEqual({ ok: true })
  })

  it('非 2xx 解析后端 { error: { code, message } } 并抛出 APIError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        // 与服务端 apiError(middleware/error.ts) 实际返回体一致
        json: async () => ({ error: { code: 'NOT_FOUND', message: 'Session not found' } }),
      }),
    )
    await expect(apiRequest('/api/sessions/x')).rejects.toMatchObject({
      status: 404,
      message: 'Session not found',
      code: 'NOT_FOUND',
    })
  })

  it('无 JSON body 时回退到 statusText', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => {
          throw new Error('no body')
        },
      }),
    )
    await expect(apiRequest('/api/whatever')).rejects.toMatchObject({
      status: 404,
      message: 'Not Found',
    })
  })

  it('204 返回 undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 }))
    const result = await apiRequest('/api/sessions/x', { method: 'DELETE' })
    expect(result).toBeUndefined()
  })
})
