import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** execFileSync 的 stdout maxBuffer 默认 1MB，大仓库的 diff/ls-files 输出可能
 * 超出——超限即抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER，快照/恢复直接失败。
 * 与 src/project/resolve.ts 的 GIT_MAX_BUFFER 同口径，统一 10MB。 */
const GIT_MAX_BUFFER = 10 * 1024 * 1024 // 10MB

/** 以数组参数执行 git（不经 shell，避免消息含特殊字符被解析）。返回 stdout。 */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
  }).trim()
}

/** 执行 git 并通过 stdin 提供 input（用于 git apply）。 */
function gitWithInput(cwd: string, args: string[], input: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
  }).trim()
}

/** 创建隔离 worktree（detached HEAD），返回其路径（子 agent 的 cwd）。 */
async function createWorktree(repoRoot: string, branchName: string): Promise<string> {
  const wtDir = await mkdtemp(join(tmpdir(), `c0de-wt-${branchName}-`))
  git(repoRoot, ['worktree', 'add', '--detach', wtDir, 'HEAD'])
  return wtDir
}

/** 计算 worktree 的完整 diff。
 *  暂存所有改动（含新文件）后 diff --cached vs HEAD = 含增/删/改的完整 delta。 */
async function captureDeltaPatch(worktreeDir: string): Promise<string> {
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
  } catch (e) {
    // apply 失败：记录后尝试 3-way 合并
    console.warn(
      '[worktree] git apply failed, retrying with --3way:',
      e instanceof Error ? e.message : String(e),
    )
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
  } catch (e) {
    // 清理失败忽略（可能已删），但记录以便排查残留 worktree
    console.warn('[worktree] worktree cleanup failed:', e instanceof Error ? e.message : String(e))
  }
}

export { applyPatchToParent, captureDeltaPatch, createWorktree, removeWorktree }
