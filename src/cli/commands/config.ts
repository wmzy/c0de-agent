import {
  loadConfigScopes,
  mergeConfig,
  mergeRaw,
  saveConfigScoped,
} from '../../core/config.js'
import type { Config } from '../../shared/types/config.js'
import type { CommandArgs } from '../parser.js'

type ConfigCommandContext = {
  args: CommandArgs
  cwd: string
  write?: (s: string) => void
}

/** 按 a.b.c 点路径从对象取值；找不到抛错。 */
function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') throw new Error(`config: key "${path}" not found`)
    cur = (cur as Record<string, unknown>)[p]
    if (cur === undefined) throw new Error(`config: key "${path}" not found`)
  }
  return cur
}

/** 按 a.b.c 点路径写值（创建中间对象）。 */
function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i] as string
    const next = cur[k]
    cur[k] = (next !== null && typeof next === 'object' ? next : {}) as Record<string, unknown>
    cur = cur[k] as Record<string, unknown>
  }
  cur[parts[parts.length - 1] as string] = value
}

/** 把字符串解析为合适的标量类型。 */
function coerce(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** 构造 a.b.c → { a: { b: { c: value } } } 的 patch 对象。 */
function setPathPatch(path: string, value: unknown): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  setByPath(root, path, value)
  return root
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
    const rawValue = ctx.args.positionals[2]
    if (!key) throw new Error('config set: a key is required')
    if (rawValue === undefined) throw new Error('config set: a value is required')
    const scope = (ctx.args.options.global as boolean | undefined) ? 'global' : 'project'
    // 只把 patch 合并进目标作用域的原始文件，不写入默认值与其他作用域的配置（P2-3）。
    const scopeCfg = scope === 'global' ? scopes.global : scopes.project
    const next = mergeRaw(scopeCfg ?? {}, setPathPatch(key, coerce(rawValue)))
    await saveConfigScoped(scope, ctx.cwd, next)
    write(`Set ${key} (scope: ${scope})\n`)
    return
  }

  throw new Error(`config: unknown subcommand "${sub ?? ''}" (expected get|set)`)
}

export type { ConfigCommandContext }
export { coerce, getByPath, runConfigCommand, setByPath, setPathPatch }
