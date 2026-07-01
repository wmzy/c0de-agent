import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { safeResolve } from '../../shared/utils/path.js'
import type { WriteInput } from '../types.js'

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
    const fullPath = safeResolve(ctx.cwd, path)
    if (fullPath === null) {
      return { _tag: 'error', error: `Path "${path}" escapes the working directory` }
    }

    try {
      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, content, 'utf-8')
      return { _tag: 'success', output: `Wrote ${content.length} bytes to ${path}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Failed to write "${path}": ${message}` }
    }
  },
}
