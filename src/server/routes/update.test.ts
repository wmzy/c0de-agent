import { describe, expect, it, vi } from 'vitest'

// vi.mock 工厂被 hoist 到顶部，必须用 vi.hoisted 创建 mock 引用，避免 ReferenceError。
const { performHotUpdateMock, serializeSessionsMock } = vi.hoisted(() => ({
  performHotUpdateMock: vi.fn(),
  serializeSessionsMock: vi.fn().mockResolvedValue({
    version: '0.1.0',
    sessions: [],
    entries: [],
    config: null,
    timestamp: 1,
  }),
}))

vi.mock('../../update/index.js', () => ({
  performHotUpdate: performHotUpdateMock,
  serializeSessions: serializeSessionsMock,
  checkForUpdate: vi.fn(),
  getCurrentVersion: () => '0.1.0',
}))

import type { ServerContext } from '../types.js'
import { createUpdateRoute } from './update.js'

/** 构造带 mock scheduler 的 ctx；getLastResult / checkNow 行为由用例控制。 */
function makeCtx(opts: {
  lastResult?: { hasUpdate: boolean; currentVersion: string; latestVersion: string } | null
  checkNowResult?: { hasUpdate: boolean; currentVersion: string; latestVersion: string }
  handoffPort?: number
}): ServerContext {
  return {
    updateScheduler: {
      getLastResult: () => opts.lastResult ?? null,
      checkNow: async () =>
        opts.checkNowResult ?? {
          hasUpdate: false,
          currentVersion: '0.0.0',
          latestVersion: '0.0.0',
        },
      start: vi.fn(),
      stop: vi.fn(),
    },
    db: {} as never,
    config: {} as never,
    handoff:
      opts.handoffPort !== undefined ? { port: opts.handoffPort, server: {} as never } : undefined,
  } as unknown as ServerContext
}

describe('GET /api/update', () => {
  it('returns cached result when scheduler has one', async () => {
    const ctx = makeCtx({
      lastResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
    })
    const app = createUpdateRoute(ctx)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { hasUpdate: boolean; latestVersion: string }
    expect(body.hasUpdate).toBe(true)
    expect(body.latestVersion).toBe('0.2.0')
  })

  it('returns placeholder when no cache and triggers checkNow (non-blocking)', async () => {
    const checkNow = vi.fn().mockResolvedValue({
      hasUpdate: true,
      currentVersion: '0.1.0',
      latestVersion: '0.3.0',
    })
    const ctx = {
      updateScheduler: { getLastResult: () => null, checkNow, start: vi.fn(), stop: vi.fn() },
    } as unknown as ServerContext
    const app = createUpdateRoute(ctx)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { hasUpdate: boolean }
    // 立即返回占位（hasUpdate:false），不 await checkNow
    expect(body.hasUpdate).toBe(false)
    // checkNow 被触发（fire-and-forget）
    expect(checkNow).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/update/apply', () => {
  it('returns 409 HOT_UPDATE_UNAVAILABLE when no handoff server (dev mode)', async () => {
    performHotUpdateMock.mockClear()
    const ctx = makeCtx({
      checkNowResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
    })
    const app = createUpdateRoute(ctx)
    const res = await app.request('/apply', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('HOT_UPDATE_UNAVAILABLE')
    expect(performHotUpdateMock).not.toHaveBeenCalled()
  })

  it('returns 409 NO_UPDATE when no update available', async () => {
    performHotUpdateMock.mockClear()
    const ctx = makeCtx({
      checkNowResult: { hasUpdate: false, currentVersion: '0.1.0', latestVersion: '0.1.0' },
      handoffPort: 9999,
    })
    const app = createUpdateRoute(ctx)
    const res = await app.request('/apply', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NO_UPDATE')
    expect(performHotUpdateMock).not.toHaveBeenCalled()
  })

  it('invokes performHotUpdate with handoffPort when update available', async () => {
    performHotUpdateMock.mockClear()
    performHotUpdateMock.mockResolvedValue({ _tag: 'success', snapshotPath: '/tmp/x.json' })
    const ctx = makeCtx({
      checkNowResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
      handoffPort: 9999,
    })
    const app = createUpdateRoute(ctx)
    const res = await app.request('/apply', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; latestVersion: string }
    expect(body.ok).toBe(true)
    expect(body.latestVersion).toBe('0.2.0')
    // performHotUpdate 被调用，第二参数含 handoffPort
    expect(performHotUpdateMock).toHaveBeenCalledTimes(1)
    const secondArg = performHotUpdateMock.mock.calls[0]?.[1] as { handoffPort?: number }
    expect(secondArg.handoffPort).toBe(9999)
  })

  it('returns 500 when performHotUpdate fails', async () => {
    performHotUpdateMock.mockClear()
    performHotUpdateMock.mockResolvedValue({
      _tag: 'install_failed',
      error: 'network down',
      snapshotPath: '/tmp/y.json',
    })
    const ctx = makeCtx({
      checkNowResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
      handoffPort: 9999,
    })
    const app = createUpdateRoute(ctx)
    const res = await app.request('/apply', { method: 'POST' })
    expect(res.status).toBe(500)
  })
})
