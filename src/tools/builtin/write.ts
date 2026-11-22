import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { errorMessage } from '../../shared/utils/string.js'
import { isURLPath, writeURL } from '../resolver.js'
import type { WriteInput } from '../types.js'
import { resolveToolPath } from './paths.js'

/**
 * write tool: create or overwrite a file.
 * Permission: ask (modifies filesystem).
 */
export const writeTool: ToolDef = {
  name: 'write',
  description: 'Create or overwrite a file with the given content. Creates parent directories.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to cwd or absolute).' },
      content: { type: 'string', description: 'Content to write.' },
    },
    required: ['path', 'content'],
  },
  permission: 'ask',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { path, content } = input as WriteInput

    // 内部 URL scheme：走 resolver 写通道（conflict:// 等）。此前 URL 会被
    // resolveToolPath 当字面文件名落到 cwd 下（写出名为 "conflict://1" 的
    // 文件），这里显式分流——只读 scheme 与未注册 scheme 报错引导模型。
    if (isURLPath(path)) {
      if (!ctx.urlRegistry) {
        return {
          _tag: 'error',
          error: `Cannot write URL "${path}": no resolver registry available`,
        }
      }
      const res = await writeURL(ctx.urlRegistry, path, content, {
        cwd: ctx.cwd,
        session: ctx.session,
      })
      if (res._tag === 'error') return { _tag: 'error', error: res.error }
      return { _tag: 'success', output: res.content }
    }

    const fullPath = resolveToolPath(ctx, path)
    if (typeof fullPath !== 'string') return fullPath

    try {
      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
      // 字节数按 UTF-8 编码计：content.length 是 UTF-16 码元数，非 ASCII 内容
      // （中文 3×、emoji 4×）会被低估数倍——工具反馈是模型/用户判断落盘
      // 大小的唯一依据，谎报字节数误导后续操作。
      return {
        _tag: 'success',
        output: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${path}`,
      }
    } catch (error) {
      const message = errorMessage(error)
      return { _tag: 'error', error: `Failed to write "${path}": ${message}` }
    }
  },
}
