import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { projectAPI } from '@/services/project.js'
import { sessionAPI } from '@/services/session.js'

/** 会话集合变化后的失效契约（单一来源）：['sessions'] + ['sessions','tree']，
 *  触碰回收站（删除/恢复/归属孤儿）再加 ['sessions','deleted']。返回 Promise
 *  供需要等失效完成再导航的调用方 await。此前 8 处调用点各手抄这两三行，
 *  内联副本已漏过 tree 键（草稿页新建会话后侧栏树不显示新会话）——契约
 *  散落必漏，收敛于此。只刷 tree（touch 排序）或只刷回收站列表的窄场景
 *  不走本契约，各自保留原样。 */
export function invalidateSessionLists(
  qc: QueryClient,
  opts: { deleted?: boolean } = {},
): Promise<void> {
  const jobs = [
    qc.invalidateQueries({ queryKey: ['sessions'] }),
    qc.invalidateQueries({ queryKey: ['sessions', 'tree'] }),
  ]
  if (opts.deleted) {
    jobs.push(qc.invalidateQueries({ queryKey: ['sessions', 'deleted'] }))
  }
  return Promise.all(jobs).then(() => undefined)
}

export function useSessionTree() {
  return useQuery({ queryKey: ['sessions', 'tree'], queryFn: () => sessionAPI.tree() })
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
      void invalidateSessionLists(qc)
    },
  })
}

export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sessionAPI.remove(id),
    onSuccess: () => {
      void invalidateSessionLists(qc, { deleted: true })
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

/** 从回收站恢复会话（可带当前项目上下文与恢复模式；孤儿会话可选重建原项目或归属当前项目）。 */
export function useRestoreSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      projectId,
      restoreMode,
    }: {
      id: string
      projectId?: string
      restoreMode?: 'auto' | 'current-project'
    }) => sessionAPI.restore(id, projectId, restoreMode),
    onSuccess: () => {
      void invalidateSessionLists(qc, { deleted: true })
    },
  })
}

/** 项目列表（用于会话列表的项目切换过滤）。 */
export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: () => projectAPI.list(), staleTime: 30_000 })
}
