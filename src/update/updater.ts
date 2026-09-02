import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSnapshot } from './snapshot.js'

/** 热更新执行结果（spec §18）。 */
type HotUpdateResult =
  | { _tag: 'success'; snapshotPath: string }
  | { _tag: 'install_failed'; error: string; snapshotPath: string }
  | { _tag: 'spawn_failed'; error: string; snapshotPath: string }

/**
 * 启动新实例的函数签名。
 * @param snapshotPath 快照文件路径（旧实例已写入）
 * @param argv          传给新进程的完整参数（含 restore flag + 可选 handoff flag）
 * @param opts          热更新选项（authToken 等经环境变量传递给新实例）
 */
type SpawnFn = (snapshotPath: string, argv: string[], opts?: HotUpdateOptions) => Promise<void>

type HotUpdateOptions = {
  /** 自更新安装函数；默认 `npm install -g <pkg>`。 */
  installFn?: (pkg: string) => Promise<void>
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
}

const DEFAULT_PACKAGE = 'c0de-agent'

/** 默认自更新：npm install -g <pkg>。 */
function defaultInstall(pkg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '-g', pkg], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm install -g ${pkg} exited with ${code}`))
    })
  })
}

/** 默认启动新实例：detached spawn CLI bin，argv = serve <restore> <handoff>。
 * 必须以 `serve` 子命令开头（CLI dispatch 按首参选命令）；
 * --port 复用旧实例端口，--handoff-port 让新实例启动后请求旧实例退出。
 * 认证 token 经环境变量传递（不落 argv，避免 ps 泄漏）。 */
function defaultSpawn(_snapshotPath: string, argv: string[], opts?: HotUpdateOptions): Promise<void> {
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

/**
 * 执行热更新（spec §18.1-18.2 流程）：
 *   1. 序列化当前会话状态到快照文件
 *   2. 全局自更新（npm install -g）
 *   3. detached 启动新版本实例，传入快照路径（新实例 restore + 端口接管）
 *
 * 注：旧实例的 graceful shutdown / 端口让渡由新实例启动后通过 IPC 协调
 * （见 ipc.ts），本函数只负责"序列化 + 安装 + 接力"。
 */
async function performHotUpdate(
  snapshot: SessionSnapshot,
  opts: HotUpdateOptions = {},
): Promise<HotUpdateResult> {
  const pkg = opts.packageName ?? DEFAULT_PACKAGE
  const dir = await mkdtemp(join(tmpdir(), 'c0de-update-'))
  const snapshotPath = opts.snapshotPath ?? join(dir, 'snapshot.json')

  await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8')

  const install = opts.installFn ?? defaultInstall
  try {
    await install(pkg)
  } catch (error) {
    return {
      _tag: 'install_failed',
      error: error instanceof Error ? error.message : String(error),
      snapshotPath,
    }
  }

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
  const spawnNew = opts.spawnNewInstanceFn ?? defaultSpawn
  try {
    await spawnNew(snapshotPath, argv, opts)
  } catch (error) {
    return {
      _tag: 'spawn_failed',
      error: error instanceof Error ? error.message : String(error),
      snapshotPath,
    }
  }

  return { _tag: 'success', snapshotPath }
}

/** 清理快照临时目录（热更新完成或放弃后调用）。 */
async function cleanupSnapshot(snapshotPath: string): Promise<void> {
  await rm(join(snapshotPath, '..'), { recursive: true, force: true }).catch(() => {})
}

export type { HotUpdateOptions, HotUpdateResult, SpawnFn }
export { cleanupSnapshot, performHotUpdate }
