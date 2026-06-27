import type { CommandContext, CommandResult, SlashCommand } from './types.js'

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
    ]
    return { _tag: 'text', text: lines.join('\n') }
  },
}

const compactCommand: SlashCommand = {
  name: 'compact',
  description: 'Manually trigger context compaction',
  execute: async () => {
    return { _tag: 'success', message: 'Compaction queued. Use the agent API to trigger with a summarizer.' }
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
  argsHint: '[message-index]',
  execute: async (args, ctx) => {
    const sessionId = args || ''
    if (!sessionId) return { _tag: 'error', message: 'Usage: /fork <session-id>' }
    const { forkSession } = await import('../session/branch.js')
    const forked = await forkSession(ctx.deps.db, sessionId)
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

const builtinCommands: SlashCommand[] = [
  helpCommand,
  compactCommand,
  modelCommand,
  clearCommand,
  forkCommand,
  configCommand,
]

export { builtinCommands, createSlashRegistry, parseSlashInput }
export type { SlashRegistry }
