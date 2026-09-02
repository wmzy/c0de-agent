import { existsSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

/**
 * 安全路径解析：确保 requestPath 解析后落在 root 内，防止路径穿越
 * （如 `../etc/passwd`、绝对路径 `/etc/passwd`）。
 *
 * - `resolve(root, requestPath)` 解析后，若结果不在 root 子树内则返回 null。
 * - 判定逻辑：`relative(root, resolved)` 以 `..` 开头即越界；
 *   再用 `resolve(root, rel) === resolved` 兜底，防止相对段恰好名为 root 的边角情况。
 * - symlink 防逃逸（P2-5）：root 与目标（或其最近已存在祖先）经 realpath 解析后，
 *   目标必须仍落在 root 实路径内；否则返回 null。
 *
 * 返回解析后的绝对路径；越界返回 null。
 */
function safeResolve(root: string, requestPath: string): string | null {
  const resolved = resolve(root, requestPath)
  const rel = relative(root, resolved)
  if (rel.startsWith('..') || resolve(root, rel) !== resolved) {
    return null
  }

  try {
    const rootReal = realpathSync(root)
    let probe = resolved
    while (!existsSync(probe)) {
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
    const probeReal = realpathSync(probe)
    if (probeReal !== rootReal && !probeReal.startsWith(rootReal + sep)) return null
  } catch {
    // realpath 失败（root 不存在等）：保持原有 relative 判定结果
  }

  return resolved
}

export { safeResolve }
