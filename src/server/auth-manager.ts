// src/server/auth-manager.ts
// P2-16：认证 token 轮换 + 新设备配对审批。
//
// 安全模型（基于用户决策：URL token / shell history 不可视为安全）：
//   - bootstrap token（auth-token 文件 / security.token / C0DE_AUTH_TOKEN）只用于
//     「首次设备注册」：首个设备凭 bootstrap 换发设备 token 后，bootstrap 立即轮换失效。
//   - 所有 API/WS 请求只认设备 token（sha256 哈希存储）。
//   - 新设备无有效 token 时走配对流程：请求配对码 → 已授权设备审批 → 下发设备 token。
//   - 显式配置 security.token 时为静态模式：不轮换、不配对（CI/脚本场景）。
//   - authEnabled=false 时不启用。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, type FSWatcher, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const DEVICES_FILENAME = 'devices.json'

type DeviceRecord = {
  id: string
  name: string
  tokenHash: string
  createdAt: number
}

type PendingPairing = {
  pairingId: string
  deviceName: string
  code: string
  createdAt: number
  status: 'pending' | 'approved' | 'denied'
  deviceToken?: string
}

type DevicesFile = {
  version: 1
  devices: DeviceRecord[]
}

type AuthManagerOptions = {
  dataDir: string
  /** 显式配置的静态 token（security.token / C0DE_AUTH_TOKEN）；非空 → 静态模式。 */
  staticToken?: string
  /** bootstrap token 文件路径（默认 dataDir/auth-token）。 */
  tokenFilePath?: string
  /** 配对码有效期（ms），默认 10 分钟。 */
  pairingTtlMs?: number
  /** 轮换后仍接受为 handoff 凭据的旧 bootstrap 数量，默认 3。 */
  handoffTokenRetention?: number
  now?: () => number
}

export type AuthManager = {
  /** 当前 bootstrap token（静态模式下即 staticToken）。 */
  readonly bootstrap: string | undefined
  /** API/WS 请求校验：仅设备 token 有效（静态模式下 staticToken 有效）。 */
  verify(token: string | undefined): boolean
  /** handoff 端点校验：设备 token + 当前/历史 bootstrap。 */
  verifyHandoff(token: string | undefined): boolean
  /** 首次设备注册：校验 bootstrap 后换发设备 token 并轮换 bootstrap。
   *  无设备时首个凭 bootstrap 的请求即视为首设备（免审批），后续请求需配对审批。
   *  返回新设备 token；bootstrap 已失效/已注册过 → 返回 null。 */
  registerFirstDevice(bootstrapToken: string, deviceName: string): Promise<string | null>
  /** 发起配对请求（未认证）：返回 { pairingId, code }；静态模式/未启用返回 null。 */
  requestPairing(deviceName: string): { pairingId: string; code: string } | null
  /** 查询配对状态（未认证）：pending / approved(含 token) / denied / not_found。 */
  pairingStatus(
    pairingId: string,
  ):
    | { status: 'pending' }
    | { status: 'approved'; deviceToken: string }
    | { status: 'denied' }
    | { status: 'not_found' }
  /** 列出待审批配对（需已认证设备调用）。 */
  listPairings(): Array<{ pairingId: string; deviceName: string; code: string; createdAt: number }>
  /** 审批配对（需已认证设备调用）：通过后为请求设备签发 token。 */
  approvePairing(pairingId: string): boolean
  /** 拒绝配对。 */
  denyPairing(pairingId: string): boolean
  /** 列出已授权设备（id/name/createdAt）。 */
  listDevices(): Array<{ id: string; name: string; createdAt: number }>
  /** 撤销某设备：立即从内存移除并落盘；返回是否成功。 */
  revokeDevice(id: string): boolean
  /** 持久化设备注册表到磁盘（fire-and-forget 调用）。 */
  persist(): void
  /** 关闭 devices.json 热重载 watcher（server dispose 时调用）。 */
  dispose(): void
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function createAuthManager(opts: AuthManagerOptions): AuthManager {
  const { dataDir, staticToken, tokenFilePath, now = Date.now } = opts
  const pairingTtlMs = opts.pairingTtlMs ?? 10 * 60 * 1000
  const handoffRetention = opts.handoffTokenRetention ?? 3
  const tokenPath = tokenFilePath ?? join(dataDir, 'auth-token')
  const devicesPath = join(dataDir, DEVICES_FILENAME)

  // ── 状态加载 ──
  let bootstrap: string | undefined =
    staticToken && staticToken.length > 0 ? staticToken : readBootstrapToken(tokenPath)

  const devices = new Map<string, DeviceRecord>()
  loadDevices()

  // 轮换历史 bootstrap（仅 handoff 校验接受，API 不接受）
  const previousBootstraps: string[] = []

  const pending = new Map<string, PendingPairing>()

  function readBootstrapToken(path: string): string | undefined {
    try {
      if (!existsSync(path)) return undefined
      const t = readFileSync(path, 'utf-8').trim()
      return t.length > 0 ? t : undefined
    } catch {
      return undefined
    }
  }

  function loadDevices(): void {
    devices.clear()
    try {
      if (!existsSync(devicesPath)) return
      const raw = JSON.parse(readFileSync(devicesPath, 'utf-8')) as DevicesFile
      for (const d of raw.devices ?? []) {
        if (d && typeof d.id === 'string' && typeof d.tokenHash === 'string') {
          devices.set(d.id, d)
        }
      }
    } catch {
      // 注册表损坏：视为空（设备需重新配对/注册）
    }
  }

  // 热重载：CLI `c0de auth revoke/reset` 或手工编辑 devices.json 后立即生效。
  // 监听目录而非文件——文件可能尚不存在（首启），persist/revoke 会创建它。
  // 自身 persist 写入也会触发一次无伤重载。
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(dirname(devicesPath), (_event, filename) => {
      if (filename === basename(devicesPath)) loadDevices()
    })
    // 不让 watcher 独占事件循环（测试/短生命周期进程可正常退出）
    watcher.unref()
  } catch {
    // 目录不可 watch（极端环境）：降级为仅启动时加载
  }

  function persist(): void {
    try {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
      const file: DevicesFile = {
        version: 1,
        devices: Array.from(devices.values()),
      }
      writeFileSync(devicesPath, JSON.stringify(file, null, 2), 'utf-8')
    } catch {
      // 持久化失败不致命（内存态继续有效，重启后需重新注册）
    }
  }

  /** 轮换 bootstrap：写入新 token 文件并保留历史（handoff 用）。 */
  function rotateBootstrap(): void {
    if (staticToken && staticToken.length > 0) return // 静态模式不轮换
    const next = randomBytes(32).toString('hex')
    if (bootstrap) {
      previousBootstraps.push(bootstrap)
      if (previousBootstraps.length > handoffRetention) previousBootstraps.shift()
    }
    bootstrap = next
    try {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
      writeFileSync(tokenPath, next, 'utf-8')
    } catch {
      // 写文件失败：内存 token 仍已轮换，进程内一致
    }
  }

  function verifyDeviceToken(token: string): boolean {
    const h = hashToken(token)
    for (const d of devices.values()) {
      if (safeEqual(d.tokenHash, h)) return true
    }
    return false
  }

  function verifyBootstrap(token: string | undefined): boolean {
    if (!token || !bootstrap) return false
    return safeEqual(token, bootstrap)
  }

  function cleanExpiredPairings(): void {
    const cutoff = now() - pairingTtlMs
    for (const [id, p] of pending) {
      if (p.status === 'pending' && p.createdAt <= cutoff) {
        pending.delete(id)
      }
    }
  }

  return {
    get bootstrap() {
      return bootstrap
    },

    verify(token) {
      if (!token) return false
      if (staticToken && staticToken.length > 0) return safeEqual(token, staticToken)
      return verifyDeviceToken(token)
    },

    verifyHandoff(token) {
      if (!token) return false
      if (verifyDeviceToken(token)) return true
      if (verifyBootstrap(token)) return true
      for (const prev of previousBootstraps) {
        if (safeEqual(token, prev)) return true
      }
      return false
    },

    async registerFirstDevice(bootstrapToken, deviceName) {
      if (staticToken && staticToken.length > 0) return null // 静态模式无设备注册
      if (!verifyBootstrap(bootstrapToken)) return null
      // 已有设备 → bootstrap 已失效，不得再凭它注册（需配对审批）
      if (devices.size > 0) return null

      const deviceToken = randomBytes(32).toString('hex')
      const record: DeviceRecord = {
        id: randomBytes(16).toString('hex'),
        name: deviceName || '设备',
        tokenHash: hashToken(deviceToken),
        createdAt: now(),
      }
      devices.set(record.id, record)
      persist()
      rotateBootstrap() // 注册成功即轮换，旧 bootstrap（URL/shell history 中）立即失效
      return deviceToken
    },

    requestPairing(deviceName) {
      if (staticToken && staticToken.length > 0) return null
      cleanExpiredPairings()
      // 限流：最多 10 个待审批
      const pendingCount = Array.from(pending.values()).filter((p) => p.status === 'pending').length
      if (pendingCount >= 10) return null
      const pairingId = randomBytes(16).toString('hex')
      const code = String(100000 + Math.floor(Math.random() * 900000)) // 6 位数字
      pending.set(pairingId, {
        pairingId,
        deviceName: deviceName || '新设备',
        code,
        createdAt: now(),
        status: 'pending',
      })
      return { pairingId, code }
    },

    pairingStatus(pairingId) {
      const p = pending.get(pairingId)
      if (!p) return { status: 'not_found' }
      if (p.status === 'approved') return { status: 'approved', deviceToken: p.deviceToken ?? '' }
      if (p.status === 'denied') return { status: 'denied' }
      if (p.createdAt <= now() - pairingTtlMs) {
        pending.delete(pairingId)
        return { status: 'not_found' }
      }
      return { status: 'pending' }
    },

    listPairings() {
      cleanExpiredPairings()
      return Array.from(pending.values())
        .filter((p) => p.status === 'pending')
        .map((p) => ({
          pairingId: p.pairingId,
          deviceName: p.deviceName,
          code: p.code,
          createdAt: p.createdAt,
        }))
    },

    approvePairing(pairingId) {
      const p = pending.get(pairingId)
      if (!p || p.status !== 'pending') return false
      if (p.createdAt <= now() - pairingTtlMs) {
        pending.delete(pairingId)
        return false
      }
      const deviceToken = randomBytes(32).toString('hex')
      const record: DeviceRecord = {
        id: randomBytes(16).toString('hex'),
        name: p.deviceName,
        tokenHash: hashToken(deviceToken),
        createdAt: now(),
      }
      devices.set(record.id, record)
      p.status = 'approved'
      p.deviceToken = deviceToken
      persist()
      return true
    },

    denyPairing(pairingId) {
      const p = pending.get(pairingId)
      if (!p || p.status !== 'pending') return false
      p.status = 'denied'
      return true
    },

    listDevices() {
      return Array.from(devices.values()).map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt,
      }))
    },

    revokeDevice(id) {
      const ok = devices.delete(id)
      if (ok) persist()
      return ok
    },

    dispose() {
      watcher?.close()
      watcher = undefined
    },

    persist,
  }
}

export type { DeviceRecord, PendingPairing }
