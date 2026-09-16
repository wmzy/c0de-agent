import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 工厂被 hoist 到顶部，必须用 vi.hoisted 创建 mock 引用，避免 ReferenceError。
const {
  performInstallMock,
  performHandoffMock,
  serializeSessionsMock,
  manualInstallCommandMock,
  captureForegroundCommandMock,
} = vi.hoisted(() => ({
  performInstallMock: vi.fn(),
  performHandoffMock: vi.fn(),
  serializeSessionsMock: vi
    .fn()
    .mockResolvedValue({ version: '0.1.0', sessions: [], entries: [], timestamp: 1 }),
  manualInstallCommandMock: vi.fn().mockReturnValue('npm install -g c0de-agent'),
  captureForegroundCommandMock: vi.fn(),
}))

vi.mock('../../update/index.js', () => ({
  performInstall: performInstallMock,
  performHandoff: performHandoffMock,
  serializeSessions: serializeSessionsMock,
  manualInstallCommand: manualInstallCommandMock,
  checkForUpdate: vi.fn(),
  getCurrentVersion: () => '0.1.0',
}))

vi.mock('../terminal/pty-manager.js', () => ({
  captureForegroundCommand: captureForegroundCommandMock,
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
/** P3：workflow busy 映射 mock（多数用例为空 Map）。 */
const workflowBusyMock = new Map<string, string>()

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
    // P3：受影响会话集合含 workflow busy 发起/工作流会话。
    workflowBusyBySession: workflowBusyMock,
    // P3-9：影响面含待确认权限数（GET / 读取 size()；P3 后按会话集合过滤）。
    permissionStore: { size: () => 0, countForSessions: () => 0 },
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
  captureForegroundCommandMock.mockReset()
  agentManagerMock.pauseAll
    .mockReset()
    .mockResolvedValue({ paused: 0, forcedAbort: 0, pausedIds: [] })
  agentManagerMock.resume.mockReset().mockReturnValue(true)
  agentManagerMock.get.mockReset()
  agentManagerMock.isStarting.mockReset().mockReturnValue(false)
  agentManagerMock.listActive.mockReset().mockReturnValue([])
  ptyManagerMock.list.mockReset().mockReturnValue([])
  workflowBusyMock.clear()
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
      impact: {
        runs: Array<{ sessionId: string; title: string }>
        terminalCount: number
        pendingPermissionCount: number
      }
    }
    expect(body.impact.runs).toHaveLength(1)
    expect(body.impact.runs[0]?.sessionId).toBe('11111111-1111-4111-8111-111111111111')
    expect(body.impact.terminalCount).toBe(2)
    // P3-9：待确认权限数透出（mock 固定 0）
    expect(body.impact.pendingPermissionCount).toBe(0)
  })

  it('P3：权限计数只统计受影响会话（活跃 run + workflow busy 发起/工作流会话）', async () => {
    const ctx = makeCtx({
      lastResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
    })
    agentManagerMock.listActive.mockReturnValue([
      { sessionId: 'run-1' },
      { sessionId: 'run-child', parentSessionId: 'run-1' },
    ])
    workflowBusyMock.set('initiator-1', 'wf-1')
    const captured: Set<string>[] = []
    ;(ctx.permissionStore as { countForSessions: (s: Set<string>) => number }).countForSessions = (
      ids,
    ) => {
      captured.push(new Set(ids))
      return 2
    }
    const app = createUpdateRoute(ctx)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { impact: { pendingPermissionCount: number } }
    expect(body.impact.pendingPermissionCount).toBe(2)
    const ids = captured[0] as Set<string>
    expect(ids.has('run-1')).toBe(true)
    expect(ids.has('run-child')).toBe(true)
    expect(ids.has('initiator-1')).toBe(true)
    expect(ids.has('wf-1')).toBe(true)
  })

  it('P3-7：impact 终端含检测到的前台命令（确认框据此勾选重启）', async () => {
    const ctx = makeCtx({
      lastResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
    })
    captureForegroundCommandMock.mockReturnValue('npm run dev')
    ptyManagerMock.list.mockReturnValue([
      { id: 'pty_1', pid: 123, title: 'dev', shell: '/bin/bash', cwd: '/app' },
    ] as never)
    const app = createUpdateRoute(ctx)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      impact: { terminals: Array<{ id: string; command?: string }> }
    }
    expect(body.impact.terminals[0]?.command).toBe('npm run dev')
  })

  it('P2-9：impact run 透出运行态与当前工具（确认框标注强杀风险）', async () => {
    const ctx = makeCtx({
      lastResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
    })
    agentManagerMock.listActive.mockReturnValue([
      { sessionId: '11111111-1111-4111-8111-111111111111', status: 'running', currentTool: 'bash' },
      { sessionId: '22222222-2222-4222-8222-222222222222', status: 'paused' },
    ])
    const app = createUpdateRoute(ctx)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      impact: { runs: Array<{ status?: string; currentTool?: string }> }
    }
    expect(body.impact.runs).toHaveLength(2)
    const running = body.impact.runs.find((r) => r.status === 'running')
    expect(running?.currentTool).toBe('bash')
    const paused = body.impact.runs.find((r) => r.status === 'paused')
    expect(paused?.currentTool).toBeUndefined()
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

  it('P3-7：apply 仅对勾选 rerunTerminalIds 的终端把前台命令写进快照', async () => {
    performInstallMock.mockResolvedValue({ _tag: 'success', installMethod: 'npm' })
    performHandoffMock.mockResolvedValue({
      _tag: 'success',
      snapshotPath: '/tmp/x.json',
      installMethod: 'npm',
    })
    captureForegroundCommandMock.mockReturnValue('npm run dev')
    ptyManagerMock.list.mockReturnValue([
      { id: 'pty_1', pid: 111, title: 'a', shell: '/bin/bash', cwd: '/app' },
      { id: 'pty_2', pid: 222, title: 'b', shell: '/bin/bash', cwd: '/app' },
    ] as never)
    const ctx = makeCtx({
      checkNowResult: { hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' },
      handoffPort: 9999,
    })
    const app = createUpdateRoute(ctx)
    const res = await app.request('/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rerunTerminalIds: ['pty_1'] }),
    })
    expect(res.status).toBe(200)
    const terminalsArg = serializeSessionsMock.mock.calls[0]?.[2] as Array<{
      id: string
      command?: string
    }>
    expect(terminalsArg).toHaveLength(2)
    expect(terminalsArg[0]).toEqual(
      expect.objectContaining({ id: 'pty_1', command: 'npm run dev' }),
    )
    expect(terminalsArg[1]?.id).toBe('pty_2')
    expect(terminalsArg[1]).not.toHaveProperty('command')
    // 仅对勾选终端查询前台命令（未勾选不查询）
    expect(captureForegroundCommandMock).toHaveBeenCalledTimes(1)
    expect(captureForegroundCommandMock).toHaveBeenCalledWith(111)
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
