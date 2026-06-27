import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import type { EditInput } from '../types.js'

/**
 * edit tool: search-and-replace editing with fuzzy whitespace matching.
 * Permission: ask (modifies filesystem).
 *
 * Matching: collapses consecutive whitespace in both oldText and file content
 * to support minor formatting differences. Returns error if oldText is not
 * found or matches multiple times (ambiguous).
 */
export const editTool: ToolDef = {
  name: 'edit',
  description:
    'Edit a file by replacing oldText with newText. Uses fuzzy whitespace matching. Returns error if oldText is not found or matches multiple times.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to cwd or absolute).' },
      oldText: { type: 'string', description: 'Text to find in the file.' },
      newText: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  permission: 'ask',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { path, oldText, newText } = input as EditInput
    const fullPath = resolve(ctx.cwd, path)

    try {
      const content = await readFile(fullPath, 'utf-8')

      // Fuzzy whitespace matching: normalize whitespace runs
      const normalize = (s: string): string => s.replace(/[ \t]+/g, ' ')

      const normalizedContent = normalize(content)
      const normalizedOld = normalize(oldText)

      // Find all match positions
      const matches: number[] = []
      let searchFrom = 0
      while (true) {
        const idx = normalizedContent.indexOf(normalizedOld, searchFrom)
        if (idx === -1) break
        matches.push(idx)
        searchFrom = idx + normalizedOld.length
      }

      if (matches.length === 0) {
        return { _tag: 'error', error: `oldText not found in "${path}"` }
      }
      if (matches.length > 1) {
        return {
          _tag: 'error',
          error: `oldText matches ${matches.length} times in "${path}" — multiple matches found, provide more context to disambiguate`,
        }
      }

      // Map normalized match back to original content
      const matchIdx = matches[0]!
      const prefix = normalizedContent.slice(0, matchIdx)
      const charCount = prefix.length

      const mapping = buildPositionMapping(content, normalizedContent)

      const origStart = mapping.get(charCount) ?? charCount
      const origEnd = mapping.get(charCount + normalizedOld.length) ?? charCount + normalizedOld.length

      const newContent = content.slice(0, origStart) + newText + content.slice(origEnd)
      await writeFile(fullPath, newContent, 'utf-8')
      return {
        _tag: 'success',
        output: `Edited "${path}": replaced ${origEnd - origStart} chars with ${newText.length} chars`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Failed to edit "${path}": ${message}` }
    }
  },
}

/**
 * Build a mapping from normalized string positions to original string positions.
 * Used to map fuzzy match results back to the original content.
 */
function buildPositionMapping(original: string, normalized: string): Map<number, number> {
  const map = new Map<number, number>()
  let origIdx = 0
  let normIdx = 0

  while (origIdx < original.length && normIdx < normalized.length) {
    map.set(normIdx, origIdx)

    if (original[origIdx] === normalized[normIdx]) {
      origIdx++
      normIdx++
    } else if (original[origIdx] === ' ' || original[origIdx] === '\t') {
      // Original has whitespace that was collapsed
      origIdx++
    } else {
      // Shouldn't happen with proper normalization
      origIdx++
      normIdx++
    }
  }
  // Map the end position
  map.set(normIdx, origIdx)
  return map
}
