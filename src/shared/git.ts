import type { SpawnSyncReturns } from 'node:child_process'
import { execFileSync, spawnSync } from 'node:child_process'

/** spawnSync/execFileSync 的 stdout/stderr maxBuffer 默认 1MB，大仓库的
 * status/diff/ls-files 输出可能超出——spawnSync 超限置 result.error，
 * execFileSync 抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER（快照/恢复直接失败）。
 * 10MB 足以覆盖大量 untracked 文件场景（此前 50MB 是为 --ignored 的 PGLite
 * 数万文件预留，去掉 --ignored 后不再需要）。 */
export const GIT_MAX_BUFFER = 10 * 1024 * 1024 // 10MB

/**
 * 以数组参数执行 git（不经 shell，避免消息含特殊字符被解析），返回原始
 * spawnSync 结果。stderr 默认丢弃（fd2 → 'ignore'）；需要读 stderr 的
 * 失败映射场景传 `{ stderr: true }`。
 */
export function gitRaw(
  cwd: string,
  args: string[],
  options?: { stderr?: boolean },
): SpawnSyncReturns<string> {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', options?.stderr === true ? 'pipe' : 'ignore'],
    maxBuffer: GIT_MAX_BUFFER,
  })
}

/** best-effort 风味：任意失败（非零退出 / spawn 错误 / 异常）返回空字符串，不抛错。 */
export function bestEffortGit(cwd: string, args: string[]): string {
  try {
    const result = gitRaw(cwd, args)
    if (result.status !== 0 || result.error) return ''
    return (result.stdout ?? '').trim()
  } catch {
    return ''
  }
}

/** 严格风味：失败抛错（execFileSync 语义——非零退出/超 maxBuffer 均抛，
 *  错误对象携带 stdout/stderr）。input 写入子进程 stdin（用于 git apply）。 */
export function strictGit(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    ...(input !== undefined && { input }),
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
  }).trim()
}

/** 非零退出时的统一错误映射：优先 git stderr，否则回退「命令 + 退出码」文本。 */
export function strictGitResult(
  result: SpawnSyncReturns<string>,
  label: string,
): { error: string } {
  const stderr = (result.stderr ?? '').trim()
  return { error: stderr || `${label} failed (exit ${result.status})` }
}
