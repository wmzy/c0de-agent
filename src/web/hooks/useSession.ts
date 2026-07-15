import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { projectAPI } from '../services/project.js'
import { sessionAPI } from '../services/session.js'

export function useSessionTree() {
  return useQuery({ queryKey: ['sessions', 'tree'], queryFn: () => sessionAPI.tree() })
}

export function useSessionList() {
  return useQuery({ queryKey: ['sessions'], queryFn: () => sessionAPI.list() })
}

export function useMessages(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', sessionId, 'messages'],
    queryFn: () => sessionAPI.messages(sessionId ?? ''),
    enabled: !!sessionId,
  })
}

export function useCreateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (params?: { title?: string; directory?: string; projectId?: string }) =>
      sessionAPI.create(params),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
    },
  })
}

export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sessionAPI.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
    },
  })
}

export function useForkSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, messageIndex }: { id: string; messageIndex: number }) =>
      sessionAPI.fork(id, messageIndex),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
    },
  })
}

/** 项目列表（用于会话列表的项目切换过滤）。 */
export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: () => projectAPI.list(), staleTime: 30_000 })
}
