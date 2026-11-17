import { get } from '@/services/api.js'

type SubcommandDef = {
  name: string
  description: string
  usage?: string
}

type CommandInfo = {
  name: string
  description: string
  argsHint?: string
  subcommands?: SubcommandDef[]
}

const commandsAPI = {
  list: () => get<{ commands: CommandInfo[] }>('/api/commands'),
}

/** 斜杠命令列表查询键（useCommands 正本；Settings 保存后失效统一走这里）。 */
export function commandsRootKey() {
  return ['commands'] as const
}

export type { CommandInfo, SubcommandDef }
export { commandsAPI }
