import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG, saveConfig } from '../../core/config.js'
import type { CommandArgs } from '../parser.js'

type InitCommandContext = {
  args: CommandArgs
  cwd: string
  log?: (s: string) => void
}

async function runInitCommand(ctx: InitCommandContext): Promise<void> {
  const log = ctx.log ?? process.stdout.write.bind(process.stdout)
  const force = (ctx.args.options.force as boolean | undefined) ?? false
  const path = join(ctx.cwd, '.c0de', 'config.json')

  if (existsSync(path) && !force) {
    throw new Error(`init: config already exists at ${path} (use --force to overwrite)`)
  }

  await saveConfig(DEFAULT_CONFIG, 'project', ctx.cwd)
  log(`Created ${path}\n`)
}

export type { InitCommandContext }
export { runInitCommand }
