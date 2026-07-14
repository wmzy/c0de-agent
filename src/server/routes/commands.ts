import { Hono } from 'hono'
import { createSlashRegistry } from '../../core/slash.js'
import type { ServerContext } from '../types.js'

/** GET / — 返回内置斜杠命令列表（name/description/argsHint）。 */
function createCommandsRoute(_ctx: ServerContext): Hono {
  const app = new Hono()
  app.get('/', (c) => {
    const registry = createSlashRegistry()
    const commands = registry.list().map((cmd) => ({
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
