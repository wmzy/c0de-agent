import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { type ApplyResult, applyPatch, parsePatch } from '../hashline/index.js'
import type { EditInput } from '../types.js'

/**
 * edit tool: file editing in two modes (spec §16.4).
 * - diff mode: search-and-replace with fuzzy whitespace matching. Provide
 *   `oldText` + `newText`. Returns error if oldText is absent or ambiguous.
 * - hashline mode: content-hash-anchored patch language (spec §16). Provide
 *   `patch`. If the file changed since the patch was generated, the hash
 *   mismatch is rejected rather than misapplied.
 *
 * Permission: ask (modifies filesystem).
 */
export const editTool: ToolDef = {
  name: 'edit',
  description:
    'Edit a file. Two modes: (1) diff — provide oldText+newText for fuzzy search-and-replace; (2) hashline — provide `patch`, a content-hash-anchored patch that fails safely if the file changed since the patch was generated.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (relative to cwd or absolute).' },
      oldText: {
        type: 'string',
        description: 'diff mode: text to find in the file (fuzzy whitespace matching).',
      },
      newText: { type: 'string', description: 'diff mode: replacement text.' },
      patch: {
        type: 'string',
        description:
          'hashline mode: a patch block like `[path#hash]\\nSWAP start-end\\nnew content\\n---`. Generate the hash from the CURRENT file content; a stale hash is rejected.',
      },
    },
    required: ['path'],
  },
  permission: 'ask',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const raw = input as EditInput
    const path = raw.path
    const fullPath = resolve(ctx.cwd, path)

    try {
      // ── hashline 模式 ──────────────────────────────────
      if ('patch' in raw && typeof raw.patch === 'string') {
        const patches = parsePatch(raw.patch)
        if (patches.length === 0) {
          return { _tag: 'error', error: `hashline: empty patch for "${path}"` }
        }

        let current = await readFile(fullPath, 'utf-8')
        for (const p of patches) {
          const r: ApplyResult = applyPatch(current, p)
          if (r._tag !== 'success') {
            return { _tag: 'error', error: formatHashlineError(path, r) }
          }
          current = r.content
        }
        await writeFile(fullPath, current, 'utf-8')
        return {
          _tag: 'success',
          output: `Edited "${path}" via hashline patch (${patches.length} block(s))`,
        }
      }

      // ── diff 模式 ──────────────────────────────────────
      if (!('oldText' in raw) || !('newText' in raw)) {
        return {
          _tag: 'error',
          error: `edit: provide either 'patch' (hashline) or 'oldText'+'newText' (diff) for "${path}"`,
        }
      }
      const oldText = raw.oldText
      const newText = raw.newText

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
      const matchIdx = matches[0] ?? 0
      const prefix = normalizedContent.slice(0, matchIdx)
      const charCount = prefix.length

      const mapping = buildPositionMapping(content, normalizedContent)

      const origStart = mapping.get(charCount) ?? charCount
      const origEnd =
        mapping.get(charCount + normalizedOld.length) ?? charCount + normalizedOld.length

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

/** 把 hashline ApplyResult 失败分支格式化为对 agent 有指导意义的错误信息。 */
function formatHashlineError(
  path: string,
  result: Exclude<ApplyResult, { _tag: 'success' }>,
): string {
  if (result._tag === 'hash_mismatch') {
    return `"${path}": hashline hash mismatch — the file changed since this patch was generated (expected ${result.expected}, actual ${result.actual}). Re-read the file and regenerate the patch with the current hash.`
  }
  const op = result.operation
  const range = 'start' in op ? `${op.start}${op.end !== op.start ? `-${op.end}` : ''}` : ''
  return `"${path}": hashline line range ${range} out of bounds for ${op._tag} operation.`
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
