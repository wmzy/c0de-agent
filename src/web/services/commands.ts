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

export type { CommandInfo, SubcommandDef }
export { commandsAPI }
