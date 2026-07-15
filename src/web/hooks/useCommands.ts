import { useQuery } from '@tanstack/react-query'
import { type CommandInfo, commandsAPI, type SubcommandDef } from '../services/commands.js'

/** 斜杠命令列表（命令很少变化，长时间缓存）。 */
export function useCommands() {
  return useQuery({
    queryKey: ['commands'],
    queryFn: () => commandsAPI.list(),
    staleTime: Infinity,
    select: (data) => data.commands,
  })
}

export type { CommandInfo, SubcommandDef }
