import {
  applyScopedPatch,
  loadConfigScopes,
  mergeConfig,
  saveConfigScoped,
} from '../../core/config.js'
import { coerce, getByPath, setPathPatch } from '../../core/config-path.js'
import type { Config } from '../../shared/types/config.js'
import type { CommandArgs } from '../parser.js'

type ConfigCommandContext = {
  args: CommandArgs
  cwd: string
  write?: (s: string) => void
}

async function runConfigCommand(ctx: ConfigCommandContext): Promise<void> {
  const write = ctx.write ?? process.stdout.write.bind(process.stdout)
  const sub = ctx.args.positionals[0]
  const scopes = loadConfigScopes(ctx.cwd)
  // get 展示用合并视图（global ← project，含默认值），与 loadConfig 语义一致。
  const config: Config = mergeConfig(scopes.global, scopes.project)

  if (sub === 'get') {
    const key = ctx.args.positionals[1]
    if (!key) {
      write(`${JSON.stringify(config, null, 2)}\n`)
      return
    }
    const val = getByPath(config, key)
    write(`${typeof val === 'object' ? JSON.stringify(val) : String(val)}\n`)
    return
  }

  if (sub === 'set') {
    const key = ctx.args.positionals[1]
    const rawArg = ctx.args.positionals[2]
    if (!key) throw new Error('config set: a key is required')
    if (rawArg === undefined) throw new Error('config set: a value is required')
    const scope = (ctx.args.options.global as boolean | undefined) ? 'global' : 'project'
    // 只把 patch 合并进目标作用域的原始文件，不写入默认值与其他作用域的配置（P2-3）。
    // 值为 null → 删除该键（作用域内取消覆盖，回落另一作用域/默认值）。
    const scopeCfg = scope === 'global' ? scopes.global : scopes.project
    const value = coerce(rawArg)
    const next = applyScopedPatch(scopeCfg ?? {}, setPathPatch(key, value))
    await saveConfigScoped(scope, ctx.cwd, next)
    write(`${value === null ? 'Unset' : 'Set'} ${key} (scope: ${scope})\n`)
    return
  }

  throw new Error(`config: unknown subcommand "${sub ?? ''}" (expected get|set)`)
}

export type { ConfigCommandContext }
export { coerce, getByPath, runConfigCommand, setPathPatch }
