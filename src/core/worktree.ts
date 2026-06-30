import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 单仓库 baseline 状态（简化版，不处理嵌套 repo）。 */
interface RepoBaseline {
  repoRoot: string
  headCommit: string
  staged: string
  unstaged: string
  untracked: string[]
}

/** 以数组参数执行 git（不经 shell，避免消息含特殊字符被解析）。返回 stdout。 */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

/** 执行 git 并通过 stdin 提供 input（用于 git apply）。 */
function gitWithInput(cwd: string, args: string[], input: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

/** 捕获仓库当前 baseline（HEAD + staged + unstaged + untracked）。 */
async function captureBaseline(repoRoot: string): Promise<RepoBaseline> {
  const headCommit = git(repoRoot, ['rev-parse', 'HEAD'])
  const staged = git(repoRoot, ['diff', '--cached', '--binary'])
  const unstaged = git(repoRoot, ['diff', '--binary'])
  const untrackedRaw = git(repoRoot, ['ls-files', '--others', '--exclude-standard'])
  const untracked = untrackedRaw.split('\n').filter(Boolean)
  return { repoRoot, headCommit, staged, unstaged, untracked }
}

/** 创建隔离 worktree（detached HEAD），返回其路径（子 agent 的 cwd）。 */
async function createWorktree(repoRoot: string, branchName: string): Promise<string> {
  const wtDir = await mkdtemp(join(tmpdir(), `c0de-wt-${branchName}-`))
  git(repoRoot, ['worktree', 'add', '--detach', wtDir, 'HEAD'])
  return wtDir
}

/** 计算 worktree 相对 baseline 的完整 diff。
 *  暂存所有改动（含新文件）后 diff --cached vs HEAD = 含增/删/改的完整 delta。 */
async function captureDeltaPatch(worktreeDir: string, _baseline?: RepoBaseline): Promise<string> {
  git(worktreeDir, ['add', '-A'])
  return git(worktreeDir, ['diff', '--cached', '--binary'])
}

/** 把 patch 应用回父仓库并自动 commit。返回 commit SHA。 */
async function applyPatchToParent(
  repoRoot: string,
  patch: string,
  commitMessage: string,
): Promise<{ commitSha: string; warnings: string[] }> {
  if (!patch.trim()) {
    return { commitSha: git(repoRoot, ['rev-parse', 'HEAD']), warnings: [] }
  }
  try {
    gitWithInput(repoRoot, ['apply'], patch)
  } catch {
    // apply 失败：尝试 3-way 合并
    gitWithInput(repoRoot, ['apply', '--3way'], patch)
  }
  git(repoRoot, ['add', '-A'])
  git(repoRoot, ['commit', '-m', commitMessage])
  return { commitSha: git(repoRoot, ['rev-parse', 'HEAD']), warnings: [] }
}

/** 清理 worktree（git worktree remove）。 */
function removeWorktree(repoRoot: string, worktreeDir: string): void {
  try {
    git(repoRoot, ['worktree', 'remove', '--force', worktreeDir])
  } catch {
    // 清理失败忽略（可能已删）
  }
}

export type { RepoBaseline }
export { applyPatchToParent, captureBaseline, captureDeltaPatch, createWorktree, removeWorktree }
