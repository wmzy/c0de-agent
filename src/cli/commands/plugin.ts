import { loadConfig, saveConfig } from '../../core/config.js'
import type { Plugin } from '../../plugins/types.js'
import type { CommandArgs } from '../parser.js'

type PluginCommandContext = {
  args: CommandArgs
  cwd: string
  discover?: (cwd: string) => Promise<Plugin[]>
  write?: (s: string) => void
}

async function runPluginCommand(ctx: PluginCommandContext): Promise<void> {
  const write = ctx.write ?? process.stdout.write.bind(process.stdout)
  const discover = ctx.discover ?? (async () => [])
  const sub = ctx.args.positionals[0]

  if (sub === 'list') {
    const plugins = await discover(ctx.cwd)
    if (plugins.length === 0) {
      write('No plugins found.\n')
      return
    }
    for (const p of plugins) {
      write(`- ${p.name}${p.version ? `@${p.version}` : ''}\n`)
    }
    return
  }

  if (sub === 'install') {
    const name = ctx.args.positionals[1]
    if (!name) throw new Error('plugin install: a plugin name is required')
    const config = await loadConfig(ctx.cwd)
    const enabled = config.plugins.enabled
    if (!enabled.includes(name)) enabled.push(name)
    await saveConfig(config, 'project', ctx.cwd)
    write(`Enabled plugin "${name}".\n`)
    return
  }

  throw new Error(`plugin: unknown subcommand "${sub ?? ''}" (expected list|install)`)
}

export type { PluginCommandContext }
export { runPluginCommand }
