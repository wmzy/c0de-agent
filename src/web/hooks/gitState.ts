// git 状态相关 React Query 的失效清单（单源）。此前 ProjectIndicator（切分支/
// 新建分支后失效五项）与 CommitButton（提交后只失效 git-status）两处手写且已
// 漂移：提交同样改变 last-commit（顶栏 hover 的「最后一次提交」会停在旧值），
// 也可能让分支首次出现（unborn branch 的首个提交）。收敛于此，两个入口同口径。
import type { QueryClient } from '@tanstack/react-query'

/**
 * 失效某项目的全部 git 派生查询 + 项目列表。
 * projects 也在清单内：项目列表的 withBranch 读实时分支，切分支后必须重取。
 */
export function invalidateGitState(qc: QueryClient, projectId: string): void {
  qc.invalidateQueries({ queryKey: ['projects'] })
  qc.invalidateQueries({ queryKey: ['files', 'git-status', projectId] })
  qc.invalidateQueries({ queryKey: ['files', 'git-branch', projectId] })
  qc.invalidateQueries({ queryKey: ['files', 'git-last-commit', projectId] })
  qc.invalidateQueries({ queryKey: ['files', 'git-branches', projectId] })
}
