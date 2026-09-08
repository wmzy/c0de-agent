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
      // P2 修复：serve 运行时持久库被占用，此前静默退化为内存库（会话不保存，
      // 仅 stderr 一行提示极易错过）。现须显式 --temp 才允许临时模式。
      { name: 'temp', type: 'boolean' },
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
    description: 'Manage CLI/web sessions (list / delete / restore / deleted).',
    options: [{ name: 'project', type: 'string' }],
  },
  {
    name: 'acp',
    description: 'Run in Agent Client Protocol mode (editor integration).',
    options: [
      // serve 占用持久库时的显式临时模式开关（与 chat --temp 同语义）。
      { name: 'temp', type: 'boolean' },
    ],
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
  /** 显式允许 serve 占用持久库时退化为内存库（--temp）；缺省时锁冲突直接报错。 */
  allowTemp?: boolean
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
        'c0de serve 正在运行并占用会话库，CLI 会话管理暂不可用（单写者限制）。\n' +
          '  1) 在 Web 界面管理会话；\n' +
          '  2) 或停止 serve（Ctrl+C）后重试本命令。',
      )
    }
    if (opts.continueSessionId) {
      throw new Error(
        `无法续聊会话 ${opts.continueSessionId}：持久库被 c0de serve 占用，内存模式无法续聊。\n` +
          `请停止 serve 后重试，或去掉 --continue 开启新会话。`,
      )
    }
    if (!opts.allowTemp) {
      // P2 修复：锁冲突不再静默降级为不保存会话的内存模式（用户极易错过 stderr
      // 提示导致对话丢失）。必须显式 --temp 确认放弃持久化。
      throw new Error(
        'c0de serve 正在运行并占用会话库，本次对话将无法保存。\n' +
          '  1) 停止 serve 后重试（对话可持久化，推荐）；\n' +
          '  2) 或加 --temp 显式接受临时模式（消息与工具调用不会保存）。',
      )
    }
    process.stderr.write(
      '[c0de] ⚠ 临时模式：消息与工具调用不会保存。停止 serve 后重试可持久化，或直接使用浏览器界面。\n',
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
      const allowTemp = args.options.temp === true
      await withAgentDeps(
        cwd,
        {
          ...(strategy ? { strategy } : {}),
          ...(continueId ? { continueSessionId: continueId } : {}),
          ...(allowTemp ? { allowTemp } : {}),
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
      await withAgentDeps(
        cwd,
        {
          strategy: 'full-auto',
          ...(args.options.temp === true ? { allowTemp: true } : {}),
        },
        (config, deps) => runAcpCommand({ config, deps }),
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
