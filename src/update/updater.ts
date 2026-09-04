import { type ChildProcess, spawn } from 'node:child_process'
import { realpathSync, statSync, watch } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { SessionSnapshot } from './snapshot.js'

/** 热更新执行结果（spec §18）。 */
type HotUpdateResult =
  | { _tag: 'success'; snapshotPath: string; installMethod: string }
  | { _tag: 'install_failed'; error: string; snapshotPath: string }
  | { _tag: 'spawn_failed'; error: string; snapshotPath: string }
  | { _tag: 'manual_install_required'; error: string; snapshotPath: string; command: string }

/**
 * 启动新实例的函数签名。
 * @param snapshotPath 快照文件路径（旧实例已写入）
 * @param argv          传给新进程的完整参数（含 restore flag + 可选 handoff flag）
 * @param opts          热更新选项（authToken 等经环境变量传递给新实例）
 */
type SpawnFn = (snapshotPath: string, argv: string[], opts?: HotUpdateOptions) => Promise<void>

type HotUpdateOptions = {
  /** 自更新安装函数；默认按检测到的安装方式（npm/pnpm）执行。 */
  installFn?: (pkg: string, method: InstallMethod) => Promise<void>
  /** 启动新实例的函数；默认 detached spawn 当前进程入口。 */
  spawnNewInstanceFn?: SpawnFn
  packageName?: string
  /** 快照写入路径；默认临时目录。 */
  snapshotPath?: string
  /** 新实例接收快照的参数前缀（默认 --restore）。 */
  restoreFlag?: string
  /** 旧实例 handoff 端口；提供时新实例启动后请求旧实例 graceful shutdown。 */
  handoffPort?: number
  /** 旧实例主服务端口；新实例 --port 复用（保证接管同一地址）。 */
  port?: number
  /** 传给新实例的认证 token（经环境变量 C0DE_AUTH_TOKEN），保证新旧实例握手同 token。 */
  authToken?: string
  /** 手动安装等待程序文件变更的超时（ms）；默认 10 分钟，超时放弃等待。 */
  manualWaitTimeoutMs?: number
}

/** 安装方式（P0-2：识别当前进程安装器；unknown = 不自动安装，提示手动更新）。 */
type InstallMethod = { kind: 'npm' } | { kind: 'pnpm' } | { kind: 'unknown'; hint: string }

const DEFAULT_PACKAGE = 'c0de-agent'
const DEFAULT_MANUAL_WAIT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 识别当前进程的安装方式：
 * - 入口脚本 realpath 含 node_modules/.pnpm → pnpm
 * - 含 node_modules（非 .pnpm）→ npm
 * - 否则 unknown（npx 缓存、源码 dev、其他）→ 不自动安装
 * 检测不到时返回 unknown，由上层提示用户手动安装。
 */
function detectInstallMethod(): InstallMethod {
  const entry = process.argv[1]
  if (!entry) return { kind: 'unknown', hint: '无法确定入口脚本' }
  let real = entry
  try {
    real = realpathSync(entry)
  } catch {
    // 入口不存在/不可解析：尝试保留原始路径判断
  }
  const p = real.replace(/\\/g, '/')
  if (p.includes('/.pnpm/')) return { kind: 'pnpm' }
  if (p.includes('/node_modules/')) return { kind: 'npm' }
  if (p.includes('/_npx/')) {
    return { kind: 'unknown', hint: '通过 npx 临时缓存运行，无法自动更新' }
  }
  return { kind: 'unknown', hint: `无法识别安装方式（入口：${basename(entry)}）` }
}

/** 默认自更新：按检测到的安装方式执行。unknown 时抛错（上层转 manual_install_required）。 */
function defaultInstall(pkg: string, method: InstallMethod): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = method.kind === 'pnpm' ? 'pnpm' : 'npm'
    const args = method.kind === 'pnpm' ? ['add', '-g', pkg] : ['install', '-g', pkg]
    const child = spawn(cmd, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))
    })
  })
}

/** 手动安装提示命令（unknown 安装方式时返回给前端展示）。 */
function manualInstallCommand(pkg: string): string {
  return `npm install -g ${pkg}   # 或 pnpm add -g ${pkg}`
}

/** 当前执行程序文件的 stat 指纹（size+mtimeMs）。 */
type FileStatFingerprint = { size: number; mtimeMs: number }

function statFingerprint(path: string): FileStatFingerprint | null {
  try {
    const s = statSync(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

/** 采集当前执行程序文件（argv[1] 及 realpath）的 stat 基线。 */
function captureProgramBaseline(): Map<string, FileStatFingerprint | null> | null {
  const entry = process.argv[1]
  if (!entry) return null
  const paths = new Set<string>([entry])
  try {
    paths.add(realpathSync(entry))
  } catch {
    // 入口不存在时仅记录原始路径
  }
  const baseline = new Map<string, FileStatFingerprint | null>()
  for (const p of paths) baseline.set(p, statFingerprint(p))
  return baseline
}

/**
 * watch 当前执行程序文件（argv[1] 及其 realpath 所在目录）变更。
 * 返回 Promise：文件内容变更（size/mtime 变化）后 resolve。
 * 采用目录 fs.watch + 1s 轮询 stat 双保险（npm 原子替换文件时 watch 事件可能丢失）。
 * baseline 由调用方在「变更发生前」采集（安装前），否则安装已改写文件导致永远等不到变化。
 * 超时（timeoutMs）或可注入的 cancel 信号触发时 reject。
 */
function waitForProgramChange(
  timeoutMs: number,
  baseline: Map<string, FileStatFingerprint | null>,
  signal?: AbortSignal,
  pollMs = 1000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const entry = process.argv[1]
    if (!entry) {
      reject(new Error('无法确定程序入口文件'))
      return
    }
    const paths = new Set<string>([entry])
    try {
      paths.add(realpathSync(entry))
    } catch {
      // 入口不存在时仅 watch 原始路径目录
    }

    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let interval: ReturnType<typeof setInterval> | null = null
    const watchers: ReturnType<typeof watch>[] = []

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (interval) clearInterval(interval)
      for (const w of watchers) w.close()
      fn()
    }

    const changed = (): boolean => {
      for (const [p, before] of baseline) {
        const after = statFingerprint(p)
        if (before === null) {
          if (after !== null) return true
          continue
        }
        if (after === null || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          return true
        }
      }
      return false
    }

    const onAbort = (): void => finish(() => reject(new Error('waiting aborted')))
    signal?.addEventListener('abort', onAbort, { once: true })

    timer = setTimeout(() => finish(() => reject(new Error('等待程序文件变更超时'))), timeoutMs)
    interval = setInterval(() => {
      if (changed()) finish(() => resolve())
    }, pollMs)

    for (const p of paths) {
      try {
        const dir = dirname(p)
        watchers.push(
          watch(dir, () => {
            if (changed()) finish(() => resolve())
          }),
        )
      } catch {
        // 目录不可 watch：依赖轮询兜底
      }
    }
  })
}

/** 默认启动新实例：detached spawn CLI bin，argv = serve <restore> <handoff>。
 * 必须以 `serve` 子命令开头（CLI dispatch 按首参选命令）；
 * --port 复用旧实例端口，--handoff-port 让新实例启动后请求旧实例退出。
 * 认证 token 经环境变量传递（不落 argv，避免 ps 泄漏）。 */
function defaultSpawn(
  _snapshotPath: string,
  argv: string[],
  opts?: HotUpdateOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child: ChildProcess = spawn(process.argv0, [process.argv[1] ?? '', ...argv], {
        detached: true,
        stdio: 'ignore',
        ...(opts?.authToken ? { env: { ...process.env, C0DE_AUTH_TOKEN: opts.authToken } } : {}),
      })
      child.unref()
      resolve()
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** 组装新实例 argv（serve --restore <snapshot> [--port] [--handoff-port]）。 */
function buildSpawnArgv(snapshotPath: string, opts: HotUpdateOptions): string[] {
  const restoreFlag = opts.restoreFlag ?? '--restore'
  const argv = [
    'serve',
    restoreFlag,
    snapshotPath,
    ...(opts.port !== undefined ? ['--port', String(opts.port)] : []),
  ]
  if (opts.handoffPort !== undefined) {
    argv.push('--handoff-port', String(opts.handoffPort))
  }
  return argv
}

/**
 * 执行热更新（spec §18.1-18.2 + P0-2 修订流程）：
 *   1. 序列化当前会话状态到快照文件
 *   2. 识别当前进程安装方式（npm/pnpm/unknown）
 *   3. 已知方式 → 自动安装；unknown → 不安装，等待用户手动安装
 *   4. watch 当前执行程序文件变更 → 触发滚动切换
 *      （detached 启动新实例 + restore 快照 + handoff 端口接管）
 *
 * 注：旧实例的 graceful shutdown / 端口让渡由新实例启动后通过 IPC 协调
 * （见 ipc.ts），本函数只负责"序列化 + 安装 + 等待程序变更 + 接力"。
 */
async function performHotUpdate(
  snapshot: SessionSnapshot,
  opts: HotUpdateOptions = {},
): Promise<HotUpdateResult> {
  const pkg = opts.packageName ?? DEFAULT_PACKAGE
  const dir = await mkdtemp(join(tmpdir(), 'c0de-update-'))
  const snapshotPath = opts.snapshotPath ?? join(dir, 'snapshot.json')

  await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8')

  // 识别安装方式
  const method = detectInstallMethod()

  // 安装前采集程序文件基线（watch 依赖此判断「变更已发生」）
  const baseline = captureProgramBaseline()

  // 已知安装方式：自动安装；unknown/安装失败 → 等用户手动安装。
  let installReason: string | null = null
  if (method.kind !== 'unknown') {
    const install = opts.installFn ?? defaultInstall
    try {
      await install(pkg, method)
    } catch (error) {
      // 已知安装方式安装失败：立即返回（不进入 10 分钟等待），快照已落盘可恢复。
      // 用户可用 c0de update --apply 重试或手动安装后重启。
      return {
        _tag: 'install_failed',
        error: error instanceof Error ? error.message : String(error),
        snapshotPath,
      }
    }
  } else {
    installReason = `${method.hint}，请手动执行 ${manualInstallCommand(pkg)} 完成更新`
  }

  if (installReason !== null) {
    if (!baseline) {
      return {
        _tag: 'manual_install_required',
        error: '无法确定程序入口文件，无法监听更新',
        snapshotPath,
        command: manualInstallCommand(pkg),
      }
    }
    try {
      await waitForProgramChange(
        opts.manualWaitTimeoutMs ?? DEFAULT_MANUAL_WAIT_TIMEOUT_MS,
        baseline,
      )
    } catch (error) {
      return {
        _tag: 'manual_install_required',
        error: error instanceof Error ? error.message : String(error),
        snapshotPath,
        command: manualInstallCommand(pkg),
      }
    }
  }

  // 程序文件已变更（自动安装落盘或用户手动安装完成）→ 滚动切换
  const spawnNew = opts.spawnNewInstanceFn ?? defaultSpawn
  const argv = buildSpawnArgv(snapshotPath, opts)
  try {
    await spawnNew(snapshotPath, argv, opts)
  } catch (error) {
    return {
      _tag: 'spawn_failed',
      error: error instanceof Error ? error.message : String(error),
      snapshotPath,
    }
  }

  return { _tag: 'success', snapshotPath, installMethod: method.kind }
}

/** 清理快照临时目录（热更新完成或放弃后调用）。 */
async function cleanupSnapshot(snapshotPath: string): Promise<void> {
  await rm(join(snapshotPath, '..'), { recursive: true, force: true }).catch(() => {})
}

export type { HotUpdateOptions, HotUpdateResult, InstallMethod, SpawnFn }
export { cleanupSnapshot, detectInstallMethod, manualInstallCommand, performHotUpdate }
