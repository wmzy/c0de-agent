// 工具路径沙箱判定的单一实现（read/write/edit/glob/grep/bash 与 file:// resolver 共用）。
//
// 此前 `safeResolve(ctx.cwd, p) === null → escapes the working directory` 守卫
// 在 7 处内联复制，解析口径与报错文案各自演化。统一收敛为本函数：越界返回与
// 工具结果同形状的 error result，文案逐字保持各调用点历史报错（label 默认
// 'Path'；bash 的 cwd 变体传 'cwd'；file:// resolver 传 'file:// path'）。
import type { ToolResult } from '../../shared/types/tool.js'
import { safeResolve } from '../../shared/utils/path.js'

/** 解析工具路径到 cwd 内的绝对路径；越界（../ 逃逸、cwd 外绝对路径）返回同形状
 *  error result。path 省略/空串时返回 ctx.cwd（glob/grep「默认搜 cwd」口径）。 */
type ToolPathError = Extract<ToolResult, { _tag: 'error' }>

function resolveToolPath(
  ctx: { cwd: string },
  path: string | undefined,
  opts?: { label?: string },
): string | ToolPathError {
  if (!path) return ctx.cwd
  const resolved = safeResolve(ctx.cwd, path)
  if (resolved === null) {
    return {
      _tag: 'error',
      error: `${opts?.label ?? 'Path'} "${path}" escapes the working directory`,
    }
  }
  return resolved
}

export { resolveToolPath }
