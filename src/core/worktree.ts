import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strictGit } from '../shared/git.js'

/** 创建隔离 worktree（detached HEAD），返回其路径（子 agent 的 cwd）。 */
async function createWorktree(repoRoot: string, branchName: string): Promise<string> {
  const wtDir = await mkdtemp(join(tmpdir(), `c0de-wt-${branchName}-`))
  strictGit(repoRoot, ['worktree', 'add', '--detach', wtDir, 'HEAD'])
  return wtDir
}

/** 计算 worktree 的完整 diff。
 *  暂存所有改动（含新文件）后 diff --cached vs HEAD = 含增/删/改的完整 delta。 */
async function captureDeltaPatch(worktreeDir: string): Promise<string> {
  strictGit(worktreeDir, ['add', '-A'])
  return strictGit(worktreeDir, ['diff', '--cached', '--binary'])
}

/** 把 patch 应用回父仓库并自动 commit。返回 commit SHA。 */
async function applyPatchToParent(
  repoRoot: string,
  patch: string,
  commitMessage: string,
): Promise<{ commitSha: string; warnings: string[] }> {
  if (!patch.trim()) {
    return { commitSha: strictGit(repoRoot, ['rev-parse', 'HEAD']), warnings: [] }
  }
  try {
    strictGit(repoRoot, ['apply'], patch)
  } catch (e) {
    // apply 失败：记录后尝试 3-way 合并
    console.warn(
      '[worktree] git apply failed, retrying with --3way:',
      e instanceof Error ? e.message : String(e),
    )
    strictGit(repoRoot, ['apply', '--3way'], patch)
  }
  strictGit(repoRoot, ['add', '-A'])
  strictGit(repoRoot, ['commit', '-m', commitMessage])
  return { commitSha: strictGit(repoRoot, ['rev-parse', 'HEAD']), warnings: [] }
}

/** 清理 worktree（git worktree remove）。 */
function removeWorktree(repoRoot: string, worktreeDir: string): void {
  try {
    strictGit(repoRoot, ['worktree', 'remove', '--force', worktreeDir])
  } catch (e) {
    // 清理失败忽略（可能已删），但记录以便排查残留 worktree
    console.warn('[worktree] worktree cleanup failed:', e instanceof Error ? e.message : String(e))
  }
}

export { applyPatchToParent, captureDeltaPatch, createWorktree, removeWorktree }
