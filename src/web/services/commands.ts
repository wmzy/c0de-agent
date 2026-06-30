import { apiRequest } from './api.js'

type CommandInfo = {
  name: string
  description: string
  argsHint?: string
}

const commandsAPI = {
  list: () => apiRequest<{ commands: CommandInfo[] }>('/api/commands'),
}

export type { CommandInfo }
export { commandsAPI }
