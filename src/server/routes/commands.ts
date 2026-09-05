import { Hono } from 'hono'
import { createSlashRegistry } from '../../core/slash.js'
import type { ServerContext } from '../types.js'

/** GET / — 返回内置斜杠命令列表（name/description/argsHint）。
 *  按 config.slashCommands.enabled 过滤：enabled 为空 = 全部启用；
 *  否则只返回启用项，保证弹窗发现性 = 可执行性（避免展示必被拒的命令）。 */
function createCommandsRoute(ctx: ServerContext): Hono {
  const app = new Hono()
  app.get('/', (c) => {
    const registry = createSlashRegistry()
    const enabledList = ctx.config.slashCommands?.enabled ?? []
    const enabledSet = new Set(enabledList.map((n) => (n.startsWith('/') ? n.slice(1) : n)))
    const commands = registry
      .list()
      .filter((cmd) => enabledSet.size === 0 || enabledSet.has(cmd.name))
      .map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        ...(cmd.argsHint ? { argsHint: cmd.argsHint } : {}),
        ...(cmd.subcommands ? { subcommands: cmd.subcommands } : {}),
      }))
    return c.json({ commands })
  })
  return app
}

export { createCommandsRoute }
