import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerContext } from '../types.js'
import { createUpdateRoute } from './update.js'

const fakeCtx = {} as ServerContext

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /api/update', () => {
  it('returns hasUpdate true when registry is ahead', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.2.0' }) }),
    )
    const app = createUpdateRoute(fakeCtx)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { hasUpdate: boolean; latestVersion: string }
    expect(body.hasUpdate).toBe(true)
    expect(body.latestVersion).toBe('0.2.0')
  })

  it('returns hasUpdate false on registry error (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const app = createUpdateRoute(fakeCtx)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { hasUpdate: boolean }
    expect(body.hasUpdate).toBe(false)
  })
})
