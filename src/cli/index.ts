#!/usr/bin/env node

// src/cli/index.ts — c0de CLI bin entry.

import { fileURLToPath } from 'node:url'
import { loadConfig } from '../core/config.js'
import type { LoopDeps } from '../core/loop.js'
import { createDB, migrateDB } from '../db/index.js'
import type { Config } from '../shared/types/config.js'
import { runAcpCommand } from './commands/acp.js'
import { runChatCommand } from './commands/chat.js'
import { runConfigCommand } from './commands/config.js'
import { runInitCommand } from './commands/init.js'
import { runPluginCommand } from './commands/plugin.js'
import { runServeCommand } from './commands/serve.js'
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

/** 封装 agent 依赖生命周期：加载配置 → 建库迁移 → 组装 deps → 使用后关库。
 *  chat / acp 两个命令复用同一套逻辑（此前在 dispatch 中各写一份）。 */
async function withAgentDeps(
  cwd: string,
  strategy: PermissionStrategy | undefined,
  fn: (config: Config, deps: LoopDeps) => Promise<void>,
): Promise<void> {
  const config = await loadConfig(cwd)
  const db = await createDB({ driver: 'pglite' })
  await migrateDB(db)
  try {
    const deps = await buildAgentDeps(config, {
      db,
      cwd,
      ...(strategy ? { permissionStrategy: strategy } : {}),
    })
    await fn(config, deps)
  } finally {
    await db.close()
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
      await withAgentDeps(cwd, strategy, (config, deps) => runChatCommand({ args, config, deps }))
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
    case 'acp': {
      // ACP 非交互：所有工具放行（编辑器侧自行控制执行授权）。
      await withAgentDeps(cwd, 'full-auto', (config, deps) => runAcpCommand({ config, deps }))
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
