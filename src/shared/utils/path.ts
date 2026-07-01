import { relative, resolve } from 'node:path'

/**
 * 安全路径解析：确保 requestPath 解析后落在 root 内，防止路径穿越
 * （如 `../etc/passwd`、绝对路径 `/etc/passwd`）。
 *
 * - `resolve(root, requestPath)` 解析后，若结果不在 root 子树内则返回 null。
 * - 判定逻辑：`relative(root, resolved)` 以 `..` 开头即越界；
 *   再用 `resolve(root, rel) === resolved` 兜底，防止相对段恰好名为 root 的边角情况。
 *
 * 返回解析后的绝对路径；越界返回 null。
 *
 * 注意：本函数基于 `relative`，不解析符号链接（symlink）。若 root 内存在指向
 * root 外的符号链接，本函数无法阻止经由该链接的逃逸——symlink 逃逸不在本次范围内。
 */
function safeResolve(root: string, requestPath: string): string | null {
  const resolved = resolve(root, requestPath)
  const rel = relative(root, resolved)
  if (rel.startsWith('..') || resolve(root, rel) !== resolved) {
    return null
  }
  return resolved
}

export { safeResolve }
