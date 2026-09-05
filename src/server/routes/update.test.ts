import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 工厂被 hoist 到顶部，必须用 vi.hoisted 创建 mock 引用，避免 ReferenceError。
const { performInstallMock, performHandoffMock, serializeSessionsMock, manualInstallCommandMock } =
  vi.hoisted(() => ({
    performInstallMock: vi.fn(),
    performHandoffMock: vi.fn(),
    serializeSessionsMock: vi
      .fn()
      .mockResolvedValue({ version: '0.1.0', sessions: [], entries: [], timestamp: 1 }),
    manualInstallCommandMock: vi.fn().mockReturnValue('npm install -g c0de-agent'),
  }))

vi.mock('../../update/index.js', () => ({
  performInstall: performInstallMock,
  performHandoff: performHandoffMock,
  serializeSessions: serializeSessionsMock,
  manualInstallCommand: manualInstallCommandMock,
  checkForUpdate: vi.fn(),
  getCurrentVersion: () => '0.1.0',
}))

import type { ServerContext } from '../types.js'
import { createUpdateRoute } from './update.js'

/** 模块级 mock（beforeEach 统一 reset），makeCtx 复用并附到 ctx 上。 */
const agentManagerMock = {
  pauseAll: vi.fn(),
  resume: vi.fn(),
  get: vi.fn(),
  isStarting: vi.fn(),
  listActive: vi.fn(),
}
const ptyManagerMock = {
  list: vi.fn(),
}

/** 构造带 mock scheduler 的 ctx；getLastResult / checkNow 行为由用例控制。 */
function makeCtx(opts: {
  lastResult?: { hasUpdate: boolean; currentVersion: string; latestVersion: string } | null
  checkNowResult?: { hasUpdate: boolean; currentVersion: string; latestVersion: string }
  handoffPort?: number
}): ServerContext {
  return {
    updateScheduler: {
      getLastResult: () => opts.lastResult ?? null,
      checkNow: () =>
        Promise.resolve(
          opts.checkNowResult ?? {
            hasUpdate: false,
            currentVersion: '0.1.0',
            latestVersion: '0.1.0',
          },
        ),
      start: vi.fn(),
      stop: vi.fn(),
    },
    config: {
      update: { enabled: true, pauseTimeoutMs: 30_000 },
    },
    agentManager: agentManagerMock,
    ptyManager: ptyManagerMock,
    db: {},
    port: 3000,
    handoff:
      opts.handoffPort !== undefined ? { port: opts.handoffPort, server: {} as never } : undefined,
    authManager: undefined,
    authToken: undefined,
  } as unknown as ServerContext
}

beforeEach(() => {
  performInstallMock.mockReset()
  performHandoffMock.mockReset()
  serializeSessionsMock.mockClear()
  agentManagerMock.pauseAll
    .mockReset()
    .mockResolvedValue({ paused: 0, forcedAbort: 0, pausedIds: [] })
  agentManagerMock.resume.mockReset().mockReturnValue(true)
  agentManagerMock.get.mockReset()
  agentManagerMock.isStarting.mockReset().mockReturnValue(false)
  agentManagerMock.listActive.mockReset().mockReturnValue([])
  ptyManagerMock.list.mockReset().mockReturnValue([])
})

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

  it('响应含 impact：活跃对话与终端数（子 agent 并入父会话不重复列出）', async () => {
    const ctx = makeCtx({
      lastResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
    })
    agentManagerMock.listActive.mockReturnValue([
      { sessionId: '11111111-1111-4111-8111-111111111111' },
      {
        sessionId: '22222222-2222-4222-8222-222222222222',
        parentSessionId: '11111111-1111-4111-8111-111111111111',
      },
    ])
    ptyManagerMock.list.mockReturnValue([{}, {}] as never)
    const app = createUpdateRoute(ctx)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      impact: { runs: Array<{ sessionId: string; title: string }>; terminalCount: number }
    }
    expect(body.impact.runs).toHaveLength(1)
    expect(body.impact.runs[0]?.sessionId).toBe('11111111-1111-4111-8111-111111111111')
    expect(body.impact.terminalCount).toBe(2)
  })

  it('returns placeholder when no cache and triggers checkNow (non-blocking)', async () => {
    const checkNow = vi.fn().mockResolvedValue({
      hasUpdate: true,
      currentVersion: '0.1.0',
      latestVersion: '0.3.0',
    })
    const ctx = makeCtx({})
    ctx.updateScheduler.getLastResult = () => null
    ctx.updateScheduler.checkNow = checkNow
    const app = createUpdateRoute(ctx)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { hasUpdate: boolean }
    // 立即返回占位（hasUpdate:false），不 await checkNow
    expect(body.hasUpdate).toBe(false)
    // checkNow 被触发（fire-and-forget）
    expect(checkNow).toHaveBeenCalledTimes(1)
  })

  it('update.enabled=false：返回 disabled 且不触发 checkNow', async () => {
    const checkNow = vi.fn()
    const ctx = makeCtx({})
    ctx.config.update.enabled = false
    ctx.updateScheduler.getLastResult = () => null
    ctx.updateScheduler.checkNow = checkNow
    const app = createUpdateRoute(ctx)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { hasUpdate: boolean; disabled?: boolean }
    expect(body.hasUpdate).toBe(false)
    expect(body.disabled).toBe(true)
    expect(checkNow).not.toHaveBeenCalled()
  })
})

describe('POST /api/update/apply', () => {
  it('returns 409 HOT_UPDATE_UNAVAILABLE when no handoff server (dev mode)', async () => {
    const ctx = makeCtx({
      checkNowResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
    })
    const app = createUpdateRoute(ctx)
    const res = await app.request('/apply', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('HOT_UPDATE_UNAVAILABLE')
    expect(performInstallMock).not.toHaveBeenCalled()
    expect(performHandoffMock).not.toHaveBeenCalled()
  })

  it('returns 409 NO_UPDATE when no update available', async () => {
    const ctx = makeCtx({
      checkNowResult: { hasUpdate: false, currentVersion: '0.1.0', latestVersion: '0.1.0' },
      handoffPort: 9999,
    })
    const app = createUpdateRoute(ctx)
    const res = await app.request('/apply', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('NO_UPDATE')
    expect(performInstallMock).not.toHaveBeenCalled()
  })

  it('P0：install 失败时返回 409 且不暂停任何会话', async () => {
    performInstallMock.mockResolvedValue({ _tag: 'install_failed', error: 'network down' })
    const ctx = makeCtx({
      checkNowResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
      handoffPort: 9999,
    })
    const app = createUpdateRoute(ctx)
    const res = await app.request('/apply', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INSTALL_FAILED')
    // 关键断言：install 失败 → 不触碰会话状态（旧实现先 pause 后 install，失败无回滚）
    expect(ctx.agentManager.pauseAll).not.toHaveBeenCalled()
    expect(performHandoffMock).not.toHaveBeenCalled()
  })

  it('P0：manual_install_required 时返回 409 且不暂停任何会话', async () => {
    performInstallMock.mockResolvedValue({
      _tag: 'manual_install_required',
      error: 'unknown install method',
      command: 'npm install -g c0de-agent',
    })
    const ctx = makeCtx({
      checkNowResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
      handoffPort: 9999,
    })
    const app = createUpdateRoute(ctx)
    const res = await app.request('/apply', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details?: { command?: string } } }
    expect(body.error.code).toBe('MANUAL_UPDATE_REQUIRED')
    expect(body.error.details?.command).toBe('npm install -g c0de-agent')
    expect(ctx.agentManager.pauseAll).not.toHaveBeenCalled()
  })

  it('install 成功后 pause → serialize → handoff，且 install 先于 pause', async () => {
    performInstallMock.mockResolvedValue({ _tag: 'success', installMethod: 'npm' })
    performHandoffMock.mockResolvedValue({
      _tag: 'success',
      snapshotPath: '/tmp/x.json',
      installMethod: 'npm',
    })
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
    expect(performInstallMock).toHaveBeenCalledTimes(1)
    expect(ctx.agentManager.pauseAll).toHaveBeenCalledTimes(1)
    // performHandoff 第二参为 installMethod，第三参含 handoffPort
    expect(performHandoffMock).toHaveBeenCalledTimes(1)
    const methodArg = performHandoffMock.mock.calls[0]?.[1] as { kind: string }
    const optsArg = performHandoffMock.mock.calls[0]?.[2] as { handoffPort?: number }
    expect(methodArg.kind).toBe('npm')
    expect(optsArg.handoffPort).toBe(9999)
    // 顺序：install 完成于 pause 之前
    const pauseAllMock = ctx.agentManager.pauseAll as unknown as ReturnType<typeof vi.fn>
    expect(
      (performInstallMock.mock.invocationCallOrder[0] ?? 0) <
        (pauseAllMock.mock.invocationCallOrder[0] ?? 1),
    ).toBe(true)
  })

  it('P0：handoff spawn 失败时 resume 暂停的会话', async () => {
    performInstallMock.mockResolvedValue({ _tag: 'success', installMethod: 'npm' })
    performHandoffMock.mockResolvedValue({
      _tag: 'spawn_failed',
      error: 'spawn ENOENT',
      snapshotPath: '/tmp/y.json',
    })
    const ctx = makeCtx({
      checkNowResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
      handoffPort: 9999,
    })
    // 模拟 2 个会话被成功暂停
    ;(ctx.agentManager.pauseAll as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      paused: 2,
      forcedAbort: 0,
      pausedIds: ['s1', 's2'],
    })
    const app = createUpdateRoute(ctx)
    const res = await app.request('/apply', { method: 'POST' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('HOT_UPDATE_FAILED')
    // 回滚：两个暂停会话都被 resume
    expect(ctx.agentManager.resume).toHaveBeenCalledTimes(2)
    expect(ctx.agentManager.resume).toHaveBeenCalledWith('s1')
    expect(ctx.agentManager.resume).toHaveBeenCalledWith('s2')
  })
})
