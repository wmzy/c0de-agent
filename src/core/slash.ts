import type { SlashCommand } from './types.js'

import { createAgent } from './agent.js'
import { BUILTIN_WORKFLOWS, createWorkflowRegistry, executeWorkflow } from './workflows/index.js'
import { createSession } from '../session/session.js'

function parseSlashInput(input: string): { name: string; args: string } | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1), args: '' }
  }
  return { name: trimmed.slice(1, spaceIdx), args: trimmed.slice(spaceIdx + 1).trim() }
}

type SlashRegistry = {
  has: (name: string) => boolean
  get: (name: string) => SlashCommand | undefined
  list: () => SlashCommand[]
  register: (cmd: SlashCommand) => void
}

function createSlashRegistry(): SlashRegistry {
  const commands = new Map<string, SlashCommand>()
  for (const cmd of builtinCommands) {
    commands.set(cmd.name, cmd)
  }
  return {
    has: (name) => commands.has(name),
    get: (name) => commands.get(name),
    list: () => Array.from(commands.values()),
    register: (cmd) => commands.set(cmd.name, cmd),
  }
}

const helpCommand: SlashCommand = {
  name: 'help',
  description: 'List available slash commands',
  execute: async () => {
    const lines = [
      'Available commands:',
      '  /compact        Manually trigger context compaction',
      '  /model <name>   Switch the current session model',
      '  /clear          Clear session messages',
      '  /help           Show this help',
      '  /fork [index]   Fork session from a message',
      '  /config [k][v]  View or set configuration',
      '  /workflow       Manage and run workflows',
    ]
    return { _tag: 'text', text: lines.join('\n') }
  },
}

const compactCommand: SlashCommand = {
  name: 'compact',
  description: 'Manually trigger context compaction',
  execute: async () => {
    // 仅声明意图：真正的压缩由消费方（loop.compactContext / chat 路由）执行，
    // 复用 createSummarizer + runCompaction，且不把 /compact 当作 user 消息发给 LLM。
    return { _tag: 'compact' }
  },
}

const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Switch the current session model',
  argsHint: '<model-name>',
  execute: async (args) => {
    if (!args) return { _tag: 'error', message: 'Usage: /model <model-name>' }
    return { _tag: 'success', message: `Model set to ${args} (takes effect next turn)` }
  },
}

const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear session messages',
  execute: async (args, ctx) => {
    if (!args) return { _tag: 'error', message: 'Usage: /clear <session-id>' }
    const { deleteEntriesByIds, getEntries } = await import('../session/message.js')
    const entries = await getEntries(ctx.deps.db, args)
    const ids = entries.map((e) => ('id' in e ? e.id : '')).filter(Boolean)
    if (ids.length > 0) {
      await deleteEntriesByIds(ctx.deps.db, ids)
    }
    return { _tag: 'success', message: `Cleared ${ids.length} entries` }
  },
}

const forkCommand: SlashCommand = {
  name: 'fork',
  description: 'Fork session from a message index',
  argsHint: '<session-id> [message-index]',
  execute: async (args, ctx) => {
    if (!args) return { _tag: 'error', message: 'Usage: /fork <session-id> [message-index]' }
    const parts = args.split(/\s+/)
    const sessionId = parts[0] ?? ''
    const messageIndex = parts[1] !== undefined ? Number.parseInt(parts[1], 10) : 0
    const { forkSession } = await import('../session/branch.js')
    const forked = await forkSession(ctx.deps.db, sessionId, messageIndex)
    return { _tag: 'success', message: `Forked to new session: ${forked.id}` }
  },
}

const configCommand: SlashCommand = {
  name: 'config',
  description: 'View or set configuration',
  argsHint: '[key] [value]',
  execute: async (args, ctx) => {
    if (!args) {
      return { _tag: 'text', text: JSON.stringify(ctx.config, null, 2) }
    }
    const parts = args.split(/\s+/)
    const key = parts[0] ?? ''
    if (parts.length === 1) {
      const value = (ctx.config as Record<string, unknown>)[key]
      return { _tag: 'text', text: `${key}: ${JSON.stringify(value)}` }
    }
    return { _tag: 'success', message: 'Config updates are handled via the config API' }
  },
}

const workflowCommand: SlashCommand = {
  name: 'workflow',
  description: 'Manage and run workflows',
  argsHint: '[run|show|list] [name] [args]',
  execute: async (args, ctx) => {
    const parts = args.split(/\s+/).filter(Boolean)
    const subcommand = parts[0] ?? 'list'

    let registry = ctx.workflowRegistry
    if (!registry) {
      // 回退：创建仅含内置的注册表
      registry = createWorkflowRegistry()
      for (const wf of BUILTIN_WORKFLOWS) {
        registry.register(wf)
      }
    }

    if (subcommand === 'list') {
      const workflows = registry.list()
      const lines = ['Available workflows:']
      for (const wf of workflows) {
        const phases = wf.meta.phases ? ` [${wf.meta.phases.join('→')}]` : ''
        lines.push(
          `  /${wf.meta.name}${phases}  — ${wf.meta.description} (${wf.source})`,
        )
      }
      lines.push('')
      lines.push('Usage: /workflow run <name> [args]')
      return { _tag: 'text', text: lines.join('\n') }
    }

    if (subcommand === 'show') {
      const name = parts[1]
      if (!name) return { _tag: 'error', message: 'Usage: /workflow show <name>' }
      const wf = registry.get(name)
      if (!wf) {
        return { _tag: 'error', message: `Unknown workflow: ${name}` }
      }
      const code = wf.sourceCode ?? '// source not available'
      return {
        _tag: 'text',
        text: `// ${wf.meta.name}: ${wf.meta.description}\n\n${code}`,
      }
    }

    if (subcommand === 'run') {
      const name = parts[1]
      if (!name) return { _tag: 'error', message: 'Usage: /workflow run <name> [args]' }
      const wfArgs = parts.slice(2).join(' ')

      const agentConfig = {
        provider: ctx.config.defaultProvider,
        model: ctx.config.defaultModel,
        tools: [],
        plugins: ctx.config.plugins.enabled,
        agentName: 'default',
      }
      const session = await createSession(
        ctx.deps.db,
        `workflow:${name}`,
        undefined,
        'workflow',
      )
      const parent = await createAgent(
        session,
        agentConfig,
        ctx.deps,
      )

      return executeWorkflow({
        registry,
        name,
        args: wfArgs,
        deps: ctx.deps,
        parent,
      })
    }

    return {
      _tag: 'error',
      message: `Unknown subcommand: ${subcommand}. Use: list, run, show`,
    }
  },
}

const builtinCommands: SlashCommand[] = [
  helpCommand,
  compactCommand,
  modelCommand,
  clearCommand,
  forkCommand,
  configCommand,
  workflowCommand,
]

export type { SlashRegistry }
export { builtinCommands, createSlashRegistry, parseSlashInput }
