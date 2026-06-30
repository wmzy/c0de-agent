import { relative, resolve } from 'node:path'

/**
 * 安全路径检查：确保 requestPath 解析后落在 root 内，防止路径穿越（如 `../etc/passwd`）。
 * 返回解析后的绝对路径；越界返回 null。
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
