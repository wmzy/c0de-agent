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

  it('非 2xx 抛出 APIError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ message: 'Session not found', code: 'NOT_FOUND' }),
      }),
    )
    await expect(apiRequest('/api/sessions/x')).rejects.toMatchObject({
      status: 404,
      message: 'Session not found',
      code: 'NOT_FOUND',
    })
  })

  it('204 返回 undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 }))
    const result = await apiRequest('/api/sessions/x', { method: 'DELETE' })
    expect(result).toBeUndefined()
  })
})
