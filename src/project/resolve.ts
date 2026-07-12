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

/** 文件 git 状态分类（用于文件树高亮）。按「最值得注意」优先级排列。 */
export type GitStatusCode = 'modified' | 'staged' | 'untracked' | 'conflict' | 'deleted' | 'ignored'

/** 目录聚合时的优先级（越大越优先展示）。ignored 最低：被忽略目录下若有真实变更仍显示变更态。 */
export const GIT_STATUS_PRIORITY: Record<GitStatusCode, number> = {
  conflict: 5,
  untracked: 4,
  modified: 3,
  staged: 2,
  deleted: 1,
  ignored: 0,
}

/** porcelain XY → 单一分类。 */
function classifyStatus(xy: string): GitStatusCode {
  const x = xy[0]
  const y = xy[1]
  if (x === '!' && y === '!') return 'ignored' // git 忽略项
  // 合并冲突：任意 U，或双方同时增/删
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflict'
  if (x === '?' && y === '?') return 'untracked'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x !== ' ' && x !== '?') return 'staged' // 已暂存（新增/修改/重命名/复制）
  if (y !== ' ' && y !== '?') return 'modified' // 工作区变更未暂存
  return 'modified'
}

/**
 * 取工作区 git status（porcelain v1, NUL 分隔），返回 path → 状态分类 的映射。
 * path 为相对 cwd 的 POSIX 路径；非 git 仓库或失败返回 null。
 */
export function getGitStatus(cwd: string): Record<string, GitStatusCode> | null {
  let result: import('node:child_process').SpawnSyncReturns<string>
  try {
    result = spawnSync('git', ['status', '--porcelain', '-z', '--ignored', '--untracked-files=all'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  if (result.error || result.status !== 0) return null
  const raw = result.stdout ?? ''
  const tokens = raw.split('\0')
  const map: Record<string, GitStatusCode> = {}
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token === '') break // 末尾空 token
    const xy = token.slice(0, 2)
    const code = classifyStatus(xy)
    const isRename = xy[0] === 'R' || xy[0] === 'C'
    // 重命名/复制："XY oldpath\0newpath"，状态挂在 newpath
    if (isRename && i + 1 < tokens.length) {
      const newPath = tokens[i + 1]!
      map[normalizePath(newPath)] = code
      i += 2
    } else {
      const rest = token.slice(3) // 跳过 "XY "
      if (rest) map[normalizePath(rest)] = code
      i += 1
    }
  }
  return map
}

/** 路径统一为 POSIX 相对（保留目录尾斜杠由调用方无需）。 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
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
  const first = names
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)[0]
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
    // 身份恒用 worktree（本地路径稳定）；remote 是可变元数据，曾用 remote 作 id 会在
    // 「先无 remote 注册、后加 remote」时导致 id 漂移——同一目录分裂成两个项目，
    // 历史会话挂在旧 id 上从列表消失。remote 仅记录到 gitRemote 字段。
    return {
      id: hash16(gitRoot),
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
