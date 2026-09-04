import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { saveConfigScoped } from '../../core/config.js'
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

  // P1-3：只写空配置——写入 DEFAULT_CONFIG 会把 providers: [] 等默认值固化进项目文件，
  // 数组整体替换语义会覆盖全局 providers，使项目内 AI 服务失效。
  await saveConfigScoped('project', ctx.cwd, {})
  log(`Created ${path}\n`)
}

export type { InitCommandContext }
export { runInitCommand }
