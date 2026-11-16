// git 状态相关 React Query 的键与失效清单（单源）。此前 ProjectIndicator（切分支/
// 新建分支后失效五项）与 CommitButton（提交后只失效 git-status）两处手写且已
// 漂移：提交同样改变 last-commit（顶栏 hover 的「最后一次提交」会停在旧值），
// 也可能让分支首次出现（unborn branch 的首个提交）。收敛于此，两个入口同口径。
// 下面的查询选项与 invalidateGitState 互为镜像：键只在此处定义，改一处即全链路一致。
import type { QueryClient } from '@tanstack/react-query'
import { fileAPI } from '@/services/file.js'

export function gitStatusKey(projectId: string) {
  return ['files', 'git-status', projectId] as const
}

export function gitStatusQueryOptions(projectId: string) {
  return {
    queryKey: gitStatusKey(projectId),
    queryFn: () => fileAPI.gitStatus(projectId),
    // 三个消费方（CommitButton/FileBrowser/ProjectIndicator）轮询口径全同 30s，
    // 烘进选项；各观察者的 enabled 等差异仍留在调用点。
    refetchInterval: 30_000,
  }
}

export function gitLastCommitKey(projectId: string) {
  return ['files', 'git-last-commit', projectId] as const
}

export function gitLastCommitQueryOptions(projectId: string) {
  return {
    queryKey: gitLastCommitKey(projectId),
    queryFn: () => fileAPI.gitLastCommit(projectId),
    refetchInterval: 30_000,
  }
}

export function gitBranchesKey(projectId: string) {
  return ['files', 'git-branches', projectId] as const
}

export function gitBranchesQueryOptions(projectId: string) {
  return {
    queryKey: gitBranchesKey(projectId),
    queryFn: () => fileAPI.gitBranches(projectId),
  }
}

/**
 * 失效某项目的全部 git 派生查询 + 项目列表。
 * projects 也在清单内：项目列表的 withBranch 读实时分支，切分支后必须重取。
 */
export function invalidateGitState(qc: QueryClient, projectId: string): void {
  qc.invalidateQueries({ queryKey: ['projects'] })
  qc.invalidateQueries({ queryKey: gitStatusKey(projectId) })
  qc.invalidateQueries({ queryKey: gitLastCommitKey(projectId) })
  qc.invalidateQueries({ queryKey: gitBranchesKey(projectId) })
}
