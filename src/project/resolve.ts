import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export type ResolvedProject = {
  id: string
  worktree: string
  vcs: 'git' | null
  gitRemote: string | null
  gitBranch: string | null
}

/** 运行 git 命令，失败返回空字符串（不抛错）。 */
function git(args: string[], cwd: string): string {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.status !== 0 || result.error) return ''
    return (result.stdout ?? '').trim()
  } catch {
    return ''
  }
}

/** 从 directory 向上查找 .git，返回仓库根；非 git 返回 null。 */
function findGitRoot(directory: string): string | null {
  let current = resolve(directory)
  // 防御性上限，避免无限向上
  for (let i = 0; i < 64; i++) {
    const dotGit = join(current, '.git')
    if (existsSync(dotGit)) {
      try {
        statSync(dotGit)
        return current
      } catch {
        // ignore
      }
    }
    const parent = resolve(current, '..')
    if (parent === current) break // 到达根
    current = parent
  }
  return null
}

/** 取第一个 remote 的 URL（origin 无果时的回退）。 */
function firstRemoteUrl(cwd: string): string {
  const names = git(['remote'], cwd)
  const first = names.split('\n').map((s) => s.trim()).filter(Boolean)[0]
  if (!first) return ''
  return git(['remote', 'get-url', first], cwd)
}

function hash16(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export function resolveProject(directory: string): ResolvedProject {
  const absolute = resolve(directory)
  const gitRoot = findGitRoot(absolute)

  if (gitRoot) {
    const remote = git(['remote', 'get-url', 'origin'], gitRoot) || firstRemoteUrl(gitRoot)
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot) || null
    // remote 优先；无 remote 用 worktree 路径
    const idSource = remote || gitRoot
    return {
      id: hash16(idSource),
      worktree: gitRoot,
      vcs: 'git',
      gitRemote: remote || null,
      gitBranch: branch,
    }
  }

  return {
    id: hash16(absolute),
    worktree: absolute,
    vcs: null,
    gitRemote: null,
    gitBranch: null,
  }
}