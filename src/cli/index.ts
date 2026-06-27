#!/usr/bin/env node

// src/cli/index.ts — c0de CLI bin entry.

import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig } from '../core/config.js'
import { createDB, migrateDB } from '../db/index.js'
import { runAcpCommand } from './commands/acp.js'
import { runChatCommand } from './commands/chat.js'
import { runConfigCommand } from './commands/config.js'
import { runInitCommand } from './commands/init.js'
import { runPluginCommand } from './commands/plugin.js'
import { runServeCommand } from './commands/serve.js'
import { buildAgentDeps } from './deps.js'
import type { CommandSpec } from './parser.js'

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
]

type DispatchOverrides = {
  runServe?: () => Promise<void>
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

  const { values, positionals } = parseArgs({
    options: Object.fromEntries(
      (spec.options ?? []).map((o) => [
        o.name,
        { type: o.type, ...(o.short ? { short: o.short } : {}) },
      ]),
    ),
    args: rest,
    allowPositionals: true,
    strict: true,
  })
  const args = { options: values as Record<string, unknown>, positionals }

  const cwd = process.cwd()

  switch (name) {
    case 'serve': {
      await runServeCommand({ args, cwd })
      return
    }
    case 'chat': {
      const config = await loadConfig(cwd)
      const db = await createDB({ driver: 'pglite' })
      await migrateDB(db)
      try {
        const deps = await buildAgentDeps(config, { db, cwd })
        await runChatCommand({ args, config, deps })
      } finally {
        await db.close()
      }
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
      const config = await loadConfig(cwd)
      const db = await createDB({ driver: 'pglite' })
      await migrateDB(db)
      try {
        const deps = await buildAgentDeps(config, { db, cwd })
        await runAcpCommand({ config, deps })
      } finally {
        await db.close()
      }
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
