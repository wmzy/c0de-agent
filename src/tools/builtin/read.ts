import { readdir, readFile, stat } from 'node:fs/promises'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { safeResolve } from '../../shared/utils/path.js'
import { isURLPath, resolveURL } from '../resolver.js'
import type { ReadInput } from '../types.js'

/** Apply optional offset/limit (1-indexed) to text content. */
function applyRange(content: string, offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return content
  const lines = content.split('\n')
  const start = (offset ?? 1) - 1 // convert to 0-indexed
  const end = limit !== undefined ? start + limit : lines.length
  return lines.slice(start, end).join('\n')
}

/**
 * read tool: read file content with optional line range.
 * Permission: auto (read-only).
 */
export const readTool: ToolDef = {
  name: 'read',
  description:
    'Read file content, or list a directory (entries with trailing `/` on subdirectories). Supports optional offset (1-indexed line number) and limit (number of lines) for files. Also resolves internal URL schemes (skill://, agent://, pr://, issue://) when a resolver registry is configured.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to cwd or absolute).' },
      offset: { type: 'number', description: 'Starting line number (1-indexed). Default: 1.' },
      limit: { type: 'number', description: 'Maximum number of lines to read.' },
    },
    required: ['path'],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { path, offset, limit } = input as ReadInput

    // 内部 URL scheme（spec §3.10）：skill://, agent://, pr:// 等。
    // 命中时走 resolver 拿到文本内容，再统一应用 offset/limit；目录列举对 URL 无意义。
    if (isURLPath(path)) {
      if (!ctx.urlRegistry) {
        return {
          _tag: 'error',
          error: `Cannot resolve URL "${path}": no resolver registry available`,
        }
      }
      const res = await resolveURL(ctx.urlRegistry, path, { cwd: ctx.cwd, session: ctx.session })
      if (res._tag === 'error') return { _tag: 'error', error: res.error }
      return { _tag: 'success', output: applyRange(res.content, offset, limit) }
    }

    const fullPath = safeResolve(ctx.cwd, path)
    if (fullPath === null) {
      return { _tag: 'error', error: `Path "${path}" escapes the working directory` }
    }

    try {
      // 目录：列出条目（子目录加 `/` 后缀），与 system prompt 的「listing a
      // directory → read」契约一致。否则 readFile 遇到目录会抛 EISDIR,
      // 而 prompt 却告诉模型 read 能列目录——模型拿到这个矛盾的错误信号后
      // 会在 glob/read/bash 之间反复试探，最终放弃调用工具而提前 stop。
      const info = await stat(fullPath)
      if (info.isDirectory()) {
        const entries = await readdir(fullPath, { withFileTypes: true })
        if (entries.length === 0) {
          return { _tag: 'success', output: `(empty directory) ${path}` }
        }
        entries.sort((a, b) => a.name.localeCompare(b.name))
        const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        return { _tag: 'success', output: lines.join('\n') }
      }

      const content = await readFile(fullPath, 'utf-8')
      return { _tag: 'success', output: applyRange(content, offset, limit) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Failed to read "${path}": ${message}` }
    }
  },
}
