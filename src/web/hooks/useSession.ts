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
      qc.invalidateQueries({ queryKey: ['sessions', 'deleted'] })
    },
  })
}

/** 回收站：已软删除的会话列表（按项目过滤，P1-7）。 */
export function useDeletedSessions(projectId?: string) {
  return useQuery({
    queryKey: ['sessions', 'deleted', projectId],
    queryFn: () => sessionAPI.deleted(projectId),
  })
}

/** 未归属项目的已删会话（孤儿，F1）：删除项目后 FK set null，需专门视图暴露。
 *  A3：仅当用户展开「未归属项目」分组时拉取（enabled）——列表查询不标记已看到，
 *  展开时由 RecycleBin 显式调用 touchOrphansSeen 启动倒计时。 */
export function useDeletedOrphans(enabled: boolean) {
  return useQuery({
    queryKey: ['sessions', 'deleted', 'orphans'],
    queryFn: () => sessionAPI.deletedOrphans(),
    enabled,
  })
}

/** A3：孤儿条目计数（不标记 seen；分组折叠时展示「N 条」用）。 */
export function useDeletedOrphansCount() {
  return useQuery({
    queryKey: ['sessions', 'deleted', 'orphans-count'],
    queryFn: () => sessionAPI.deletedOrphansCount(),
  })
}

/** 从回收站恢复会话（可带当前项目上下文，孤儿会话自动归属）。 */
export function useRestoreSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, projectId }: { id: string; projectId?: string }) =>
      sessionAPI.restore(id, projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
      qc.invalidateQueries({ queryKey: ['sessions', 'deleted'] })
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
