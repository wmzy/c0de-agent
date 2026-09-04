#!/usr/bin/env node

// src/cli/index.ts — c0de CLI bin entry.

import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../core/config.js'
import type { LoopDeps } from '../core/loop.js'
import type { DB } from '../db/client.js'
import { createDB, migrateDB } from '../db/index.js'
import { acquireDevDbLock, releaseDevDbLock, resolveDbDir } from '../server/server.js'
import type { Config } from '../shared/types/config.js'
import { runAcpCommand } from './commands/acp.js'
import { runAuthCommand } from './commands/auth.js'
import { runChatCommand } from './commands/chat.js'
import { runConfigCommand } from './commands/config.js'
import { runInitCommand } from './commands/init.js'
import { runPluginCommand } from './commands/plugin.js'
import { runServeCommand } from './commands/serve.js'
import { runSessionsCommand } from './commands/sessions.js'
import { runUpdateCommand } from './commands/update.js'
import { buildAgentDeps, type PermissionStrategy } from './deps.js'
import { type CommandSpec, parseCommand } from './parser.js'

const COMMANDS: CommandSpec[] = [
  {
    name: 'chat',
    description: 'Ask a one-shot question; print the answer.',
    options: [
      { name: 'model', type: 'string' },
      { name: 'format', type: 'string' },
      { name: 'yes', type: 'boolean', short: 'y' },
      { name: 'continue', type: 'string' },
    ],
  },
  {
    name: 'serve',
    description: 'Start the HTTP server (default when no command given).',
    options: [
      { name: 'port', type: 'string' },
      { name: 'open', type: 'boolean' },
      { name: 'restore', type: 'string' },
      { name: 'handoff-port', type: 'string' },
    ],
  },
  {
    name: 'init',
    description: 'Create a .c0de/config.json in the current project.',
    options: [{ name: 'force', type: 'boolean', short: 'f' }],
  },
  {
    name: 'config',
    description: 'Get or set configuration values.',
    options: [{ name: 'global', type: 'boolean', short: 'g' }],
  },
  {
    name: 'plugin',
    description: 'List or enable plugins.',
    options: [],
  },
  {
    name: 'auth',
    description: 'Manage authorized devices (list / revoke / reset).',
    options: [],
  },
  {
    name: 'sessions',
    description: 'Manage CLI/web sessions (list / delete).',
    options: [],
  },
  {
    name: 'acp',
    description: 'Run in Agent Client Protocol mode (editor integration).',
    options: [],
  },
  {
    name: 'update',
    description: 'Check npm registry for a newer version (--apply to hot-update).',
    options: [{ name: 'apply', type: 'boolean' }],
  },
]

type DispatchOverrides = {
  runServe?: () => Promise<void>
}

/** 判别持久库错误是否为「库被其它 c0de 进程占用」的锁冲突特征（读 server.ts 确认）：
 *  - acquireDevDbLock 对 live lock 抛出的 "Database is locked by another c0de process (PID …)"；
 *  - PGLite 单写者 WASM 崩溃 RuntimeError "Aborted()"（serve 未持锁但占用 dataDir 时的兜底特征）。
 *  其余错误（磁盘故障、迁移失败等）不属于锁冲突，不得误报 serve。 */
function isDbLockConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.message.includes('Database is locked by another c0de process')) return true
  return err.name === 'RuntimeError' && /abort/i.test(err.message)
}

type AgentDepsOptions = {
  /** 权限策略：undefined → 按 config.permission.defaultMode 决定。 */
  strategy?: PermissionStrategy
  /** --continue 指定的会话 id：依赖持久库，降级内存模式时无法续聊。 */
  continueSessionId?: string
  /** 必须使用持久库（如 sessions 命令）；锁冲突时不降级内存库而是直接报错。 */
  requirePersistent?: boolean
}

/** 封装 agent 依赖生命周期：加载配置 → 建库迁移 → 组装 deps → 使用后关库。
 *  chat / acp 两个命令复用同一套逻辑（此前在 dispatch 中各写一份）。
 *  数据库优先用全局 dataDir 持久库（会话可恢复，--continue 可用）；
 *  仅当错误是锁冲突特征（dataDir 被 serve 实例占用）时退化为内存库并 stderr 提示，
 *  其它持久库错误如实上抛（main 统一打印 + 非零退出）；
 *  带 --continue 时内存库不含历史会话，直接报错退出而非误导性的 session not found。 */
async function withAgentDeps(
  cwd: string,
  opts: AgentDepsOptions,
  fn: (config: Config, deps: LoopDeps) => Promise<void>,
): Promise<void> {
  const config = await loadConfig(cwd)
  const dataDir = resolveDbDir()
  let db: DB
  let holdLock = false
  try {
    mkdirSync(dataDir, { recursive: true })
    acquireDevDbLock(dataDir)
    holdLock = true
    db = await createDB({ driver: 'pglite', dataDir })
    await migrateDB(db)
  } catch (err) {
    if (holdLock) releaseDevDbLock(dataDir)
    holdLock = false
    if (!isDbLockConflict(err)) throw err
    if (opts.requirePersistent) {
      throw new Error(
        'c0de serve 正在运行并占用会话库。请通过 Web UI 管理会话，或停止 serve 后重试。',
      )
    }
    if (opts.continueSessionId) {
      throw new Error(
        `无法续聊会话 ${opts.continueSessionId}：持久库被 c0de serve 占用，内存模式无法续聊。\n` +
          `请停止 serve 后重试，或去掉 --continue 开启新会话。`,
      )
    }
    process.stderr.write(
      '[c0de] ⚠ c0de serve 正在运行：本次对话为临时模式，消息与工具调用不会保存。\n' +
        '       停止 serve 后重试可持久化，或直接使用浏览器界面。\n',
    )
    db = await createDB({ driver: 'pglite' })
    await migrateDB(db)
  }
  try {
    const deps = await buildAgentDeps(config, {
      db,
      cwd,
      ...(opts.strategy ? { permissionStrategy: opts.strategy } : {}),
    })
    await fn(config, deps)
  } finally {
    await db.close()
    if (holdLock) releaseDevDbLock(dataDir)
  }
}

async function dispatch(argv: string[], overrides: DispatchOverrides = {}): Promise<void> {
  const [command, ...rest] = argv
  const name = command ?? 'serve'

  if (name === 'serve' && overrides.runServe) {
    await overrides.runServe()
    return
  }

  const spec = COMMANDS.find((c) => c.name === name)
  if (!spec) throw new Error(`cli: unknown command "${name}"`)

  const args = parseCommand(spec, rest)
  const cwd = process.cwd()

  switch (name) {
    case 'serve': {
      await runServeCommand({ args, cwd })
      return
    }
    case 'chat': {
      // --yes / -y 显式放行写操作；否则按 config.permission.defaultMode 决定（默认 safe）。
      const strategy = args.options.yes ? ('full-auto' as const) : undefined
      const continueId = args.options.continue as string | undefined
      await withAgentDeps(
        cwd,
        {
          ...(strategy ? { strategy } : {}),
          ...(continueId ? { continueSessionId: continueId } : {}),
        },
        (config, deps) => runChatCommand({ args, config, deps }),
      )
      return
    }
    case 'init': {
      await runInitCommand({ args, cwd })
      return
    }
    case 'config': {
      await runConfigCommand({ args, cwd })
      return
    }
    case 'plugin': {
      await runPluginCommand({ args, cwd })
      return
    }
    case 'auth': {
      await runAuthCommand({ args })
      return
    }
    case 'sessions': {
      // 需要持久库列出/清理会话；serve 运行时内存库不含数据，直接失败而不是列空表。
      await withAgentDeps(cwd, { requirePersistent: true }, (_config, deps) =>
        runSessionsCommand({ args, db: deps.db }),
      )
      return
    }
    case 'acp': {
      // ACP 非交互：所有工具放行（编辑器侧自行控制执行授权）。
      await withAgentDeps(cwd, { strategy: 'full-auto' }, (config, deps) =>
        runAcpCommand({ config, deps }),
      )
      return
    }
    case 'update': {
      await runUpdateCommand({ args, cwd })
      return
    }
    default: {
      throw new Error(`cli: unknown command "${name}"`)
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  try {
    await dispatch(argv)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

export { COMMANDS, dispatch }

// bin 入口：仅在直接执行时运行 main（非被 import）。
const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  void main()
}
