// LSP 服务器生命周期管理：按 `${name}:${workspaceRoot}` 惰性启动并缓存客户端；
// idle 超时（默认 5 分钟无出站消息）自动 shutdown→exit→kill；进程退出后下次
// acquire 重启（每个 key 至多重启一次，反复退出按崩溃上报而非无限重启）。

import { getLogger } from '../core/logger.js'
import { createLspClient, type LspSpawn } from './client.js'
import { resolveBinary } from './servers.js'
import type { LspClient, LspServerDef } from './types.js'

const logger = getLogger('lsp.manager')

const DEFAULT_IDLE_MS = 5 * 60_000

type ManagedEntry = {
  client: LspClient
  /** initialize 握手 promise（并发 acquire 复用；失败时由首个持有者清理）。 */
  ready: Promise<void>
  restarts: number
  idleTimer?: ReturnType<typeof setTimeout>
}

type LspManagerOptions = {
  spawn?: LspSpawn
  /** idle 回收时限；0 = 不回收。 */
  idleMs?: number
}

type LspManager = {
  acquire: (server: LspServerDef, workspaceRoot: string) => Promise<LspClient>
  disposeAll: () => Promise<void>
}

function createLspManager(opts: LspManagerOptions = {}): LspManager {
  const idleMs = opts.idleMs === undefined ? DEFAULT_IDLE_MS : opts.idleMs
  const entries = new Map<string, ManagedEntry>()

  const keyOf = (server: LspServerDef, workspaceRoot: string): string =>
    `${server.name}:${workspaceRoot}`

  const clearIdle = (key: string): void => {
    const entry = entries.get(key)
    if (entry?.idleTimer) clearTimeout(entry.idleTimer)
  }

  const resetIdle = (key: string): void => {
    const entry = entries.get(key)
    if (!entry) return
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    if (idleMs <= 0) return
    entry.idleTimer = setTimeout(() => {
      logger.info(`idle ${idleMs}ms: shutting down ${key}`)
      entries.delete(key)
      void entry.client.dispose()
    }, idleMs)
    entry.idleTimer.unref?.()
  }

  const disposeAll = async (): Promise<void> => {
    const all = Array.from(entries.values())
    entries.clear()
    for (const entry of all) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
    }
    await Promise.allSettled(all.map((entry) => entry.client.dispose()))
  }

  const acquire = async (server: LspServerDef, workspaceRoot: string): Promise<LspClient> => {
    const key = keyOf(server, workspaceRoot)
    const existing = entries.get(key)
    if (existing) {
      if (!existing.client.isDead()) {
        resetIdle(key)
        await existing.ready
        return existing.client
      }
      // 死亡重启路径：至多一次；再次退出按「服务器反复崩溃」上报。
      if (existing.restarts >= 1) {
        clearIdle(key)
        entries.delete(key)
        await existing.client.dispose().catch(() => {})
        throw new Error(
          `LSP server "${server.name}" (workspace ${workspaceRoot}) keeps exiting; ` +
            'check its binary/version or disable it via lsp.servers.<name>.disabled',
        )
      }
      clearIdle(key)
      entries.delete(key)
      await existing.client.dispose().catch(() => {})
      logger.info(`restarting dead LSP client ${key}`)
    }

    const binary = resolveBinary(server.command, workspaceRoot)
    if (!binary) {
      throw new Error(
        `LSP server "${server.name}" command "${server.command}" not found ` +
          `(checked ${workspaceRoot}/node_modules/.bin and PATH)`,
      )
    }
    const client = createLspClient({
      server,
      binary,
      workspaceRoot,
      ...(opts.spawn ? { spawn: opts.spawn } : {}),
      onActivity: () => resetIdle(key),
    })
    const entry: ManagedEntry = {
      client,
      ready: Promise.resolve(),
      // 本 key 已重启次数：首个客户端为 0，崩溃重启为 1（再崩溃即上报）。
      restarts: existing ? existing.restarts + 1 : 0,
    }
    entry.ready = client
      .initialize()
      .then(() => {})
      .catch((e: unknown) => {
        // 握手失败：清理本条目后上抛，下次 acquire 重新启动。
        entries.delete(key)
        void client.dispose()
        throw e
      })
    entries.set(key, entry)
    resetIdle(key)
    await entry.ready
    return client
  }

  return { acquire, disposeAll }
}

/** 模块级默认实例（tools/builtin/lsp.ts 消费）。 */
const defaultLspManager = createLspManager()

export type { LspManager, LspManagerOptions }
export { createLspManager, DEFAULT_IDLE_MS, defaultLspManager }
