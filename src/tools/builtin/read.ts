import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import type { ReadInput } from '../types.js'

/**
 * read tool: read file content with optional line range.
 * Permission: auto (read-only).
 */
export const readTool: ToolDef = {
  name: 'read',
  description:
    'Read file content. Supports optional offset (1-indexed line number) and limit (number of lines).',
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
    const fullPath = resolve(ctx.cwd, path)

    try {
      const content = await readFile(fullPath, 'utf-8')

      if (offset === undefined && limit === undefined) {
        return { _tag: 'success', output: content }
      }

      const lines = content.split('\n')
      const start = (offset ?? 1) - 1 // convert to 0-indexed
      const end = limit !== undefined ? start + limit : lines.length
      const sliced = lines.slice(start, end)
      return { _tag: 'success', output: sliced.join('\n') }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Failed to read "${path}": ${message}` }
    }
  },
}
