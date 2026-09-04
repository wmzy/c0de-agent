import { applyScopedPatch, loadConfigScopes, mergeConfig } from '../../core/config.js'
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
    // P1-2：只把 plugins.enabled 合并进 project 作用域文件，不整体落盘
    //（saveConfig 全量写入会把默认值与全局配置固化进项目文件）。
    const scopes = loadConfigScopes(ctx.cwd)
    const enabled = [...(mergeConfig(scopes.global, scopes.project).plugins?.enabled ?? [])]
    if (!enabled.includes(name)) enabled.push(name)
    const next = applyScopedPatch(scopes.project ?? {}, { plugins: { enabled } })
    const { saveConfigScoped } = await import('../../core/config.js')
    await saveConfigScoped('project', ctx.cwd, next)
    write(`Enabled plugin "${name}".\n`)
    return
  }

  throw new Error(`plugin: unknown subcommand "${sub ?? ''}" (expected list|install)`)
}

export type { PluginCommandContext }
export { runPluginCommand }
