// 来源：P2-16 认证轮换+设备配对功能（2026-09-03 批次）。
// 归并建议：与 src/server/middleware/auth.test.ts 同域；未来合并进 server/auth 域测试。
// 新建文件原因：auth-manager 是新增模块，无既有测试文件覆盖。

import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthManager } from './auth-manager.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c0de-auth-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 模拟服务端启动：resolveAuthToken 先生成 bootstrap 落盘，再创建 authManager。 */
function managerWithBootstrap(
  opts: Parameters<typeof createAuthManager>[0],
): ReturnType<typeof createAuthManager> {
  if (opts.staticToken === undefined) {
    writeFileSync(join(opts.dataDir, 'auth-token'), randomBytes(24).toString('hex'), {
      mode: 0o600,
    })
  }
  return createAuthManager(opts)
}

describe('createAuthManager — 设备注册与 token 轮换（P2-16）', () => {
  it('首设备凭 bootstrap 注册：换发设备 token 后 bootstrap 失效', async () => {
    const mgr = managerWithBootstrap({ dataDir: dir })
    const bootstrap = mgr.bootstrap
    expect(bootstrap).toBeDefined()

    const deviceToken = await mgr.registerFirstDevice(bootstrap ?? '', '浏览器')
    expect(deviceToken).toBeDefined()
    // 设备 token 可用于 API 校验
    expect(mgr.verify(deviceToken ?? '')).toBe(true)
    // bootstrap 已被轮换：旧 bootstrap 不再有效
    expect(mgr.verify(bootstrap ?? '')).toBe(false)
    // 新 bootstrap 已写入文件且与旧值不同
    expect(mgr.bootstrap).toBeDefined()
    expect(mgr.bootstrap).not.toBe(bootstrap)
    // handoff 校验仍接受历史 bootstrap（热更新新旧实例握手）
    expect(mgr.verifyHandoff(bootstrap ?? '')).toBe(true)
  })

  it('bootstrap 已消费后不允许再次注册（需配对审批）', async () => {
    const mgr = managerWithBootstrap({ dataDir: dir })
    const bootstrap = mgr.bootstrap ?? ''
    const first = await mgr.registerFirstDevice(bootstrap, 'a')
    expect(first).toBeDefined()
    const second = await mgr.registerFirstDevice(bootstrap, 'b')
    expect(second).toBeNull()
  })

  it('设备注册表持久化：重启后设备 token 仍有效', async () => {
    const mgr1 = managerWithBootstrap({ dataDir: dir })
    const bootstrap = mgr1.bootstrap ?? ''
    const deviceToken = await mgr1.registerFirstDevice(bootstrap, 'a')
    mgr1.persist()

    const mgr2 = createAuthManager({ dataDir: dir })
    expect(mgr2.verify(deviceToken ?? '')).toBe(true)
    // 重启后 bootstrap 取自文件（已轮换值），旧值无效
    expect(mgr2.verify(bootstrap)).toBe(false)
  })

  it('静态 token 模式：不轮换不配对，staticToken 直接有效', async () => {
    const mgr = managerWithBootstrap({ dataDir: dir, staticToken: 'fixed-token' })
    expect(mgr.verify('fixed-token')).toBe(true)
    expect(mgr.verify('other')).toBe(false)
    expect(await mgr.registerFirstDevice('fixed-token', 'x')).toBeNull()
    expect(mgr.requestPairing('x')).toBeNull()
  })
})

describe('createAuthManager — 设备配对审批（P2-16）', () => {
  async function registered(mgr: ReturnType<typeof createAuthManager>): Promise<string> {
    const token = await mgr.registerFirstDevice(mgr.bootstrap ?? '', '旧设备')
    expect(token).toBeDefined()
    return token ?? ''
  }

  it('配对请求 → 审批 → 新设备轮询拿到 token', async () => {
    const mgr = managerWithBootstrap({ dataDir: dir })
    await registered(mgr)

    const req = mgr.requestPairing('新手机')
    expect(req).not.toBeNull()
    expect(req?.code).toMatch(/^\d{6}$/)

    expect(mgr.pairingStatus(req?.pairingId ?? '')).toEqual({ status: 'pending' })
    const pending = mgr.listPairings()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.code).toBe(req?.code)

    expect(mgr.approvePairing(req?.pairingId ?? '')).toBe(true)
    const status = mgr.pairingStatus(req?.pairingId ?? '')
    expect(status.status).toBe('approved')
    if (status.status === 'approved') {
      expect(mgr.verify(status.deviceToken)).toBe(true)
    }
    // 审批后从待审批列表消失
    expect(mgr.listPairings()).toHaveLength(0)
  })

  it('拒绝配对：新设备轮询得到 denied', async () => {
    const mgr = managerWithBootstrap({ dataDir: dir })
    await registered(mgr)
    const req = mgr.requestPairing('x')
    expect(mgr.denyPairing(req?.pairingId ?? '')).toBe(true)
    expect(mgr.pairingStatus(req?.pairingId ?? '')).toEqual({ status: 'denied' })
  })

  it('配对码过期后 status 返回 not_found', async () => {
    const now = Date.now()
    const mgr = managerWithBootstrap({ dataDir: dir, pairingTtlMs: 60_000 })
    await registered(mgr)
    const req = mgr.requestPairing('x')
    // 过期：ttl=0 的实例中任何请求立即过期
    const mgr2 = createAuthManager({ dataDir: dir, pairingTtlMs: 0, now: () => now })
    const req2 = mgr2.requestPairing('y')
    expect(req2).not.toBeNull()
    expect(mgr2.pairingStatus(req2?.pairingId ?? '')).toEqual({ status: 'not_found' })
    expect(req?.pairingId).toBeDefined()
  })

  it('待审批上限 10 个：超出返回 null', async () => {
    const mgr = managerWithBootstrap({ dataDir: dir })
    await registered(mgr)
    for (let i = 0; i < 10; i++) {
      expect(mgr.requestPairing(`d${i}`)).not.toBeNull()
    }
    expect(mgr.requestPairing('d11')).toBeNull()
  })
})

describe('createAuthManager — 设备热重载与撤销（P1-4/P2-5）', () => {
  it('外部修改 devices.json 后 watcher 热重载：新设备 token 生效、被删设备失效', async () => {
    const mgr = managerWithBootstrap({ dataDir: dir })
    const deviceToken = await mgr.registerFirstDevice(mgr.bootstrap ?? '', 'a')
    expect(mgr.verify(deviceToken ?? '')).toBe(true)

    // 模拟 c0de auth reset：外部删除注册表文件
    rmSync(join(dir, 'devices.json'))
    await vi.waitFor(() => {
      expect(mgr.verify(deviceToken ?? '')).toBe(false)
    })
    mgr.dispose()
  })

  it('revokeDevice 立即从内存移除并落盘', async () => {
    const mgr = managerWithBootstrap({ dataDir: dir })
    const deviceToken = await mgr.registerFirstDevice(mgr.bootstrap ?? '', 'a')
    const devices = mgr.listDevices()
    expect(devices).toHaveLength(1)
    const id = devices[0]?.id ?? ''

    expect(mgr.revokeDevice(id)).toBe(true)
    expect(mgr.revokeDevice(id)).toBe(false)
    expect(mgr.verify(deviceToken ?? '')).toBe(false)
    expect(mgr.listDevices()).toHaveLength(0)

    // 重启后仍为空（落盘生效）
    const mgr2 = createAuthManager({ dataDir: dir })
    expect(mgr2.listDevices()).toHaveLength(0)
    expect(mgr2.verify(deviceToken ?? '')).toBe(false)
    mgr.dispose()
  })

  it('注册表损坏 → 视为空（设备需重新注册）', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'devices.json'), '{broken')
    const mgr = createAuthManager({ dataDir: dir })
    expect(mgr.listDevices()).toHaveLength(0)
    mgr.dispose()
  })
})
