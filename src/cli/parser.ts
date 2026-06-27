import { parseArgs } from 'node:util'

type OptionType = 'string' | 'boolean'

type CommandOption = {
  name: string
  type: OptionType
  short?: string
  default?: unknown
}

type CommandSpec = {
  name: string
  description: string
  options?: CommandOption[]
}

type CommandArgs = {
  options: Record<string, unknown>
  positionals: string[]
}

function parseCommand(spec: CommandSpec, argv: string[]): CommandArgs {
  const opts: Record<string, { type: OptionType; short?: string }> = {}
  const defaults: Record<string, unknown> = {}
  for (const o of spec.options ?? []) {
    const key = o.name
    opts[key] = { type: o.type, ...(o.short ? { short: o.short } : {}) }
    if (o.default !== undefined) defaults[key] = o.default
  }

  const { values, positionals } = parseArgs({
    options: opts,
    args: argv,
    allowPositionals: true,
    strict: true,
  })

  const merged: Record<string, unknown> = { ...defaults }
  for (const k of Object.keys(opts)) {
    if (values[k] !== undefined) {
      merged[k] = values[k]
    } else if (opts[k]?.type === 'boolean' && defaults[k] === undefined) {
      merged[k] = false
    }
  }
  return { options: merged, positionals }
}

export type { CommandArgs, CommandOption, CommandSpec, OptionType }
export { parseCommand }
