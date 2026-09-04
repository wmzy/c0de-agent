// src/server/server.ts

import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Server as NodeServer } from 'node:http'
import { connect as tcpConnect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { serve } from '@hono/node-server'
import type { Hono } from 'hono'
import { WebSocketServer } from 'ws'
import { BUILTIN_AGENTS, createAgentRegistry } from '../core/agents/index.js'
import { loadConfig } from '../core/config.js'
import { decryptSecret } from '../core/secret.js'
import { createAndPopulateRegistry } from '../core/workflows/index.js'
import type { DB } from '../db/client.js'
import { createDB, migrateDB } from '../db/index.js'
import type { Registry } from '../llm/registry.js'
import {
  createRegistry,
  overrideToCapabilities,
  rebuildRegistry,
  registerProvider,
} from '../llm/registry.js'
import { initPlugins } from '../plugins/index.js'
import { purgeDeletedSessions } from '../session/session.js'
import type { Config } from '../shared/types/config.js'
import type { ProviderConfig } from '../shared/types/llm.js'
import { createDefaultRegistry, createDefaultURLRegistry } from '../tools/index.js'
import {
  checkForUpdate,
  createHandoffServer,
  createUpdateScheduler,
  requestHandoff,
  restoreSessions,
  type SessionSnapshot,
} from '../update/index.js'
// HandoffError 经深导入（而非 update/index.js barrel）获取：barrel 归 update
// 包维护，此处仅用其类型标注 requestHandoff 抛错的 kind/status 分流。
import type { HandoffError } from '../update/ipc.js'
import { createAgentManager } from './agent-manager.js'
import { createApp } from './app.js'
import { createAuthManager } from './auth-manager.js'
import { isAllowedOrigin } from './middleware/cors.js'
import { createPermissionStore } from './permission/store.js'
import { PTYManager } from './terminal/pty-manager.js'
import type { HandoffServer, ServerContext } from './types.js'

type StartServerOptions = {
  port?: number
  cwd?: string
  /** 注入已有 DB（测试用）。 */
  db?: DB
  /** 热更新新实例启动时从此快照文件恢复会话状态。 */
  restoreFrom?: string
  /** 新实例启动时提供：请求旧实例 handoff 后再绑端口（spec §18.3）。 */
  handoffPort?: number
  /** 测试注入：跳过 handoff 请求与重试绑端口。 */
  skipHandoff?: boolean
  /** 测试注入：覆盖 checkForUpdate（默认走真实 npm registry）。 */
  checkForUpdateFn?: typeof checkForUpdate
  /** 测试注入：覆盖 createHandoffServer。 */
  createHandoffFn?: typeof createHandoffServer
}

type RunningServer = {
  app: Hono
  port: number
  /** 认证 token（authEnabled=false 时为 undefined）；serve 命令据此打印带 token 的 URL。 */
  authToken?: string
  close(): Promise<void>
}

type BootstrappedServer = {
  ctx: ServerContext
  close(): Promise<void>
}

/** 把 config.providers 注册到新建的 LLM registry（修复此前空 registry 的遗漏）。 */
function buildRegistryFromConfig(config: Config): Registry {
  const registry = createRegistry()
  for (const p of config.providers) {
    registerProviderFromConfig(registry, p)
  }
  return registry
}

function registerProviderFromConfig(registry: Registry, p: ProviderConfig): void {
  // 兼容 config.json 中以 _tag 标识 provider 的格式（name 缺失时回退到 _tag）
  const name = p.name || (p as { _tag?: string })._tag
  if (!name || !p.baseURL) return
  // baseURL 已含 /v1 时用 /chat/completions，避免 /v1/v1 双重前缀
  const path = p.baseURL.replace(/\/+$/, '').endsWith('/v1') ? '/chat/completions' : undefined
  registerProvider(registry, {
    name,
    baseURL: p.baseURL,
    apiKey: p.apiKey ? decryptSecret(p.apiKey) : p.apiKey,
    ...(path ? { path } : {}),
    // 传递用户配置的 per-model capabilities（contextWindow 等），
    // 否则 resolveRoute 回退到 DEFAULT_MODEL_CAPABILITIES，可能导致预算过小。
    ...(p.models ? { models: overrideToCapabilities(p.models) } : {}),
  })
}

/**
 * config 变更后原子地同步 registry：在隔离的 next registry 上重建全部路由，
 * 完成后一次性替换 registry 内部 table 引用。运行中的 resolveRoute 任何时刻
 * 看到的都是完整的旧表或完整的新表，不会读到「已清空但未注册完」的半状态，
 * 因此不会把本可用的 provider 误判为 NoRoute。ServerContext 立即生效，无需重启。
 */
function syncRegistryFromConfig(registry: Registry, config: Config): void {
  rebuildRegistry(registry, (next) => {
    for (const p of config.providers) {
      registerProviderFromConfig(next, p)
    }
  })
}

/** 全局数据根目录：XDG_DATA_HOME 优先，否则 ~/.local/share/c0de。
 * 与 opencode (~/.local/share/opencode/)、oh-my-pi (~/.omp/agent/) 同约定——
 * 数据库等运行时数据放全局，项目 .c0de/ 只留配置和扩展。 */
function resolveGlobalDataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME
  if (xdg && xdg.trim() !== '') return join(xdg, 'c0de')
  return join(homedir(), '.local', 'share', 'c0de')
}

/** 解析 PGLite 持久化数据目录：优先 C0DE_DB_DIR，否则全局数据根下 pglite 子目录。
 *
 * 历史上数据库放在 <cwd>/.c0de/pglite（项目级），但项目 DB schema 通过 projectId
 * 区分项目，设计本意是全局共享单库。旧路径已在 migrateLegacyPglite 中自动迁移。 */
function resolveDbDir(): string {
  const envDir = process.env.C0DE_DB_DIR
  if (envDir && envDir.trim() !== '') return envDir
  return join(resolveGlobalDataRoot(), 'pglite')
}

/**
 * 认证 token 解析（P0 安全修复）：
 * 1. security.authEnabled 显式为 false → 无认证（用户显式选择）。
 * 2. 用户配置 security.token → 使用。
 * 3. 环境变量 C0DE_AUTH_TOKEN（热更新新实例经 updater 传入）→ 采用并落盘。
 * 4. dataDir 下 auth-token 文件（跨重启/热更新稳定）→ 复用。
 * 5. 都没有 → 生成随机 token 并写入 auth-token（0600）。
 */
function resolveAuthToken(config: Config, dataDir: string): string | undefined {
  if (config.security.authEnabled === false) return undefined
  if (config.security.token && config.security.token.length > 0) return config.security.token

  const tokenFile = join(dataDir, 'auth-token')
  const envToken = process.env.C0DE_AUTH_TOKEN

  if (envToken) {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(tokenFile, envToken, { mode: 0o600 })
    } catch {
      // 落盘失败不影响本次运行
    }
    return envToken
  }

  try {
    const existing = readFileSync(tokenFile, 'utf-8').trim()
    if (existing) return existing
  } catch {
    // 文件不存在，走生成分支
  }

  const generated = randomBytes(24).toString('hex')
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(tokenFile, generated, { mode: 0o600 })
  } catch {
    // 落盘失败：本次运行仍可用内存 token
  }
  return generated
}

/** 只读 dataDir 下已存在的 auth-token（新实例 handoff 握手用；不生成）。 */
function readAuthTokenFile(dataDir: string): string | undefined {
  try {
    const t = readFileSync(join(dataDir, 'auth-token'), 'utf-8').trim()
    return t || undefined
  } catch {
    return undefined
  }
}

/** 一次性迁移：<cwd>/.c0de/pglite → 全局路径。仅当目标不存在时执行。
 *
 * 多个项目各有 .c0de/pglite 时只迁移第一个遇到的（首次启动即触发）；
 * 其余项目的旧数据保留在原地（已被 .gitignore 覆盖，不影响 git，但不再读取）。
 * 用户可用 C0DE_DB_DIR 手动指向旧路径访问遗留数据。 */
function migrateLegacyPglite(cwd: string, targetDir: string): void {
  const legacy = join(cwd, '.c0de', 'pglite')
  if (!existsSync(legacy)) return
  if (existsSync(targetDir)) return // 全局目录已有数据，不覆盖
  const parent = dirname(targetDir)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  try {
    renameSync(legacy, targetDir)
    return
  } catch {
    // 跨文件系统 rename 失败，fallback 到 copy
  }
  try {
    cpSync(legacy, targetDir, { recursive: true })
    rmSync(legacy, { recursive: true, force: true })
  } catch {
    // 迁移失败：旧数据留在项目目录（已 gitignore，无害），用户可手动迁移
  }
}

/**
 * 围绕已有 DB handle 组装 ServerContext（不建/不关闭 DB）。
 *
 * dev 热重载重建复用此函数：PGLite 单写者约束下 DB handle 必须跨重载存活，
 * 但 ctx 其余资源（agentManager/permissionStore/registries/plugins）全部重建为新实例。
 * 返回的 dispose 清理 ctx 资源但**不 close db**——db 由调用方持有。
 */
async function buildServerContext(
  db: DB,
  opts: StartServerOptions = {},
): Promise<{ ctx: ServerContext; dispose: () => Promise<void> }> {
  const cwd = opts.cwd ?? process.cwd()

  if (opts.restoreFrom) {
    const snapshot = JSON.parse(readFileSync(opts.restoreFrom, 'utf8')) as SessionSnapshot
    await restoreSessions(db, snapshot)
  }

  const config = await loadConfig(cwd)
  const toolRegistry = createDefaultRegistry(config)
  const llmRegistry = buildRegistryFromConfig(config)
  const urlRegistry = createDefaultURLRegistry()
  const { pluginRegistry, hookRunner } = await initPlugins({
    cwd,
    config,
    toolRegistry,
    llmRegistry,
  })

  // 工作流注册表：三级发现（builtin → global → project），eager 初始化。
  // 此前是惰性 getter 只注册 builtin，导致项目级 .c0de/workflows/*.js 永远不可见。
  const workflowRegistry = await createAndPopulateRegistry(cwd)

  const dataDir = resolveDbDir()
  // 先解析/生成 bootstrap token（落盘），再创建 authManager 读取——
  // 首启时文件由 resolveAuthToken 生成，顺序颠倒会导致 bootstrap 读到空值。
  const resolvedToken = resolveAuthToken(config, dataDir)
  const authManager = createAuthManager({
    dataDir,
    ...(config.security.token && config.security.token.length > 0
      ? { staticToken: config.security.token }
      : {}),
  })

  const ctx: ServerContext = {
    db,
    config,
    toolRegistry,
    llmRegistry,
    urlRegistry,
    hookRunner,
    pluginRegistry,
    agentManager: createAgentManager(),
    permissionStore: createPermissionStore(),
    permissionMode: config.permission.defaultMode,
    sessionPermissionModes: new Map(),
    authToken: resolvedToken,
    authManager: config.security.authEnabled === false ? undefined : authManager,
    // Agent 注册表：内置 4 个默认 agent；项目/用户自定义 agent 可在启动后补充加载。
    agentRegistry: (() => {
      const reg = createAgentRegistry()
      for (const def of BUILTIN_AGENTS) reg.register(def)
      return reg
    })(),
    workflowRegistry,
    // spec §18.1 后台版本检查调度器；config.update.enabled 控制是否启动。
    updateScheduler: createUpdateScheduler({
      checkFn: opts.checkForUpdateFn ?? checkForUpdate,
      intervalMs: config.update.intervalMs,
      initialDelayMs: config.update.initialDelayMs,
    }),
    cwd,
    ptyManager: new PTYManager(),
  }

  // handoff server 不在此创建：它需要持有主 HTTP server 引用以触发完整关停，
  // 由 startServer 在 serve() 之后创建（dev 模式走 vite，不创建）。
  return {
    ctx,
    dispose: async () => {
      // dev 重建前调用：中止活跃 run + settle pending permission +
      // 停 scheduler + 关 devices.json watcher。**不 close db**（调用方持有）。
      ctx.agentManager.dispose()
      ctx.permissionStore.dispose()
      ctx.updateScheduler.stop()
      ctx.ptyManager.dispose()
      ctx.authManager?.dispose()
    },
  }
}

const DEV_LOCK_FILE = '.dev.lock'

/**
 * Cross-process guard for PGLite dataDir.
 *
 * PGLite is single-writer WASM Postgres — two processes on the same dataDir
 * always abort (`RuntimeError: Aborted()`). This lock prevents silent
 * corruption when multiple dev servers (e.g. different ports) target the
 * same project.
 *
 * - Live PID in lock → throw clear error instead of cryptic WASM abort.
 * - Dead PID in lock → stale: remove `.dev.lock` + `postmaster.pid`, proceed.
 */
function acquireDevDbLock(dataDir: string): void {
  const lockPath = join(dataDir, DEV_LOCK_FILE)
  if (existsSync(lockPath)) {
    const oldPid = parseInt(readFileSync(lockPath, 'utf8').trim(), 10)
    let stale = false
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0) // signal 0 = liveness check
      } catch (err: unknown) {
        // ESRCH = process dead → stale lock, fall through to cleanup.
        // Any other error (EPERM etc.) re-throws — don't clobber a live lock.
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
        stale = true
      }
      if (!stale) {
        throw new Error(
          `Database is locked by another c0de process (PID ${oldPid}).\n` +
            `PGLite is single-writer — only one process may use:\n  ${dataDir}\n` +
            `Kill the other process and retry:\n  kill ${oldPid}`,
        )
      }
    }
    // Stale lock cleanup
    try {
      unlinkSync(lockPath)
    } catch {
      /* best-effort */
    }
    try {
      unlinkSync(join(dataDir, 'postmaster.pid'))
    } catch {
      /* best-effort */
    }
  }
  writeFileSync(lockPath, String(process.pid))
}

/** Release the dev DB lock (best-effort, stale-detection covers missed calls). */
function releaseDevDbLock(dataDir: string): void {
  try {
    unlinkSync(join(dataDir, DEV_LOCK_FILE))
  } catch {
    /* best-effort */
  }
}

/** dev 专用：创建 + migrate PGLite，跨热重载复用（单写者，只建一次）。 */
async function createDevDb(cwd: string): Promise<DB> {
  const dataDir = resolveDbDir()
  migrateLegacyPglite(cwd, dataDir)
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })

  acquireDevDbLock(dataDir)

  const db = await createDB({ driver: 'pglite', dataDir })
  // migrateDB 失败必须 close + release lock，否则 WASM 实例泄漏锁住 dataDir。
  try {
    await migrateDB(db)
  } catch (err) {
    await db.close().catch(() => {})
    releaseDevDbLock(dataDir)
    throw err
  }
  return db
}

/** 初始化 DB + 配置 + 注册表，返回 ServerContext + 清理函数（dev 与独立后端共用）。 */
async function bootstrapServerContext(opts: StartServerOptions = {}): Promise<BootstrappedServer> {
  const cwd = opts.cwd ?? process.cwd()
  const ownsDb = !opts.db
  // 持久化 PGLite 数据：全局路径 ~/.local/share/c0de/pglite（可用 C0DE_DB_DIR 覆盖）。
  // 跨项目共享单库，通过 projects/sessions 表的 projectId 区分。
  // 测试注入 opts.db 时跳过（保持 in-memory 隔离）。
  let db: DB
  if (opts.db) {
    db = opts.db
    // 注入 db 仍需 migrate（测试可能注入全新 in-memory db）。
    // migrateDB 失败时若 ownsDb 才 close（注入的由调用方管）。
    try {
      await migrateDB(db)
    } catch (err) {
      if (ownsDb) await db.close().catch(() => {})
      throw err
    }
  } else {
    db = await createDevDb(cwd)
  }

  const { ctx, dispose } = await buildServerContext(db, opts)

  // 回收站清理：启动时清一次 + 每 24h 清一次（软删除保留 30 天）。
  // fire-and-forget：清理失败不阻塞服务启动。
  void purgeDeletedSessions(db).catch(() => {})
  const purgeTimer = setInterval(
    () => {
      void purgeDeletedSessions(db).catch(() => {})
    },
    24 * 60 * 60 * 1000,
  )
  purgeTimer.unref()

  // P2-15：PGLite WAL 周期刷盘（30s），缩短 kill -9 等突然停机时的已提交数据丢失窗口。
  const syncTimer = db.sync
    ? setInterval(() => {
        void db.sync?.().catch(() => {})
      }, 30_000)
    : null
  syncTimer?.unref()

  return {
    ctx,
    close: async () => {
      clearInterval(purgeTimer)
      if (syncTimer) clearInterval(syncTimer)
      await dispose()
      if (ownsDb) await db.close()
    },
  }
}

/**
 * 请求旧实例 handoff 后轮询端口释放（spec §18.3）。旧实例收到 /handoff 后
 * 优雅退出释放端口；新实例轮询 TCP 连接直到被拒（端口已释放）或超时报错。
 */
async function requestHandoffWithRetry(
  port: number,
  token?: string,
  maxAttempts = 30,
  delayMs = 100,
): Promise<void> {
  try {
    await requestHandoff(port, '127.0.0.1', token)
  } catch (err) {
    const handoffErr = err as HandoffError
    // 连接层失败（ECONNREFUSED 等）：旧实例未启 handoff 端点（update 未启用）；
    // 直接尝试绑端口。
    if (handoffErr?.kind === 'connect') return
    // HTTP 401：旧实例存在但 auth token 不匹配——立即明确报错退出。若继续
    // bind 必撞 EADDRINUSE，把真实原因（token 校验失败）误报成端口占用。
    if (handoffErr?.kind === 'http' && handoffErr.status === 401) {
      throw new Error(
        `handoff: 端口 ${port} 上的旧实例拒绝让渡（HTTP 401：auth token 不匹配）。\n` +
          `新旧实例须共享同一 token（C0DE_AUTH_TOKEN 环境变量或数据目录 auth-token 文件），\n` +
          `请核对配置后重试。`,
      )
    }
    throw err
  }
  for (let i = 0; i < maxAttempts; i++) {
    const released = await new Promise<boolean>((resolve) => {
      const sock = tcpConnect({ host: '127.0.0.1', port })
      sock.once('connect', () => {
        sock.destroy()
        resolve(false) // 连上 → 旧实例还在
      })
      sock.once('error', () => resolve(true)) // 连接拒绝 → 端口已释放
    })
    if (released) return
    await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new Error(
    `handoff: old instance on port ${port} did not release after ${maxAttempts} attempts`,
  )
}
async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const port = opts.port ?? 3000

  // spec §18.3：新实例从 --handoff-port 拿到旧实例端口，请求优雅退出后绑端口。
  // 握手 token：updater spawn 时经 C0DE_AUTH_TOKEN 环境变量传入，否则读 auth-token 文件。
  if (opts.handoffPort && !opts.skipHandoff) {
    const pendingToken = process.env.C0DE_AUTH_TOKEN ?? readAuthTokenFile(resolveDbDir())
    await requestHandoffWithRetry(opts.handoffPort, pendingToken)
  }

  const { ctx, close: closeCtx } = await bootstrapServerContext(opts)
  const app = createApp(ctx)

  // config.update.enabled 时启动后台调度器。
  if (ctx.config.update.enabled) ctx.updateScheduler.start()

  const server = serve({ fetch: app.fetch, port }) as unknown as NodeServer
  ctx.port = port

  // WebSocket：终端双向流。Hono v2 无原生 WS，用 ws 包直接挂载到 HTTP server。
  // 匹配 /api/terminal/:id/ws → ptyManager.attachWebSocket
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
    const match = url.pathname.match(/^\/api\/terminal\/([^/]+)\/ws$/)
    if (!match) {
      socket.destroy()
      return
    }
    // Origin 校验：浏览器 WS 不受 CORS 约束，必须在服务端显式校验。
    // 非浏览器客户端（无 Origin 头）放行——token 仍是硬门槛。
    const origin = req.headers.origin
    if (origin && !isAllowedOrigin(origin, ctx.config.security.allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    // 认证：token 通过 query 参数传递（浏览器 WS 无法设置 Authorization header）。
    // P2-16：优先 authManager 校验（设备 token）；回退 ctx.authToken 兼容测试上下文。
    if (ctx.authManager || ctx.authToken) {
      const token = url.searchParams.get('token')
      const ok = ctx.authManager
        ? ctx.authManager.verify(token ?? undefined)
        : token === ctx.authToken
      if (!ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
    }
    const ptyId = match[1]
    if (!ptyId) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const attached = ctx.ptyManager.attachWebSocket(ptyId, ws)
      if (!attached) {
        ws.send(JSON.stringify({ type: 'error', message: 'Terminal not found' }))
        ws.close(1008, 'Terminal not found')
      }
    })
  })

  let closed = false
  const closeMain = async () => {
    if (closed) return
    closed = true
    wss.close()
    server.close()
    await closeCtx()
  }
  const close = async () => {
    await closeMain()
    await handoffServer?.close()
  }

  // spec §18.3 handoff server：旧实例收到 POST /handoff 后关闭主服务与资源，
  // 响应 200，随后退出进程（exitAfterResponse），端口让渡给新实例。
  // config.update.enabled=false 或 skipHandoff 时跳过。
  let handoffServer: HandoffServer | undefined
  if (ctx.config.update.enabled && !opts.skipHandoff) {
    const createHandoff = opts.createHandoffFn ?? createHandoffServer
    handoffServer = await createHandoff(closeMain, {
      // P2-16：token 轮换后新旧实例 bootstrap 可能不同，用 verifyHandoff 接受
      // 当前/历史 bootstrap 与设备 token；无 authManager 回退字符串比较。
      ...(ctx.authManager
        ? { verify: (t) => ctx.authManager?.verifyHandoff(t) ?? false }
        : { expectedToken: ctx.authToken }),
      exitAfterResponse: true,
    })
    ctx.handoff = { port: handoffServer.port, server: handoffServer }
  }

  return { app, port, close, ...(ctx.authToken ? { authToken: ctx.authToken } : {}) }
}

export type { BootstrappedServer, RunningServer, StartServerOptions }
export {
  acquireDevDbLock,
  bootstrapServerContext,
  buildRegistryFromConfig,
  buildServerContext,
  createDevDb,
  releaseDevDbLock,
  resolveAuthToken,
  resolveDbDir,
  startServer,
  syncRegistryFromConfig,
}
