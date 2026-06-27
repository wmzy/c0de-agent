import { readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import type { GlobInput } from '../types.js'

/** Directories always skipped during glob traversal. */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.turbo'])

/**
 * Convert a glob pattern to a RegExp.
 * Supports: * (single segment), ** (across segments), ? (single char), {a,b} (alternation), [abc] (char class).
 */
export function globToRegex(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i += 2
        if (pattern[i] === '/') i++ // skip separator after **
      } else {
        re += '[^/]*'
        i++
      }
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) {
        re += '\\{'
        i++
      } else {
        const inner = pattern.slice(i + 1, end)
        re += `(?:${inner.split(',').map(escapeRegex).join('|')})`
        i = end + 1
      }
    } else if (c === '[') {
      const end = pattern.indexOf(']', i)
      if (end === -1) {
        re += '\\['
        i++
      } else {
        re += pattern.slice(i, end + 1)
        i = end + 1
      }
    } else if ('.+^$()|\\'.includes(c)) {
      re += `\\${c}`
      i++
    } else {
      re += c
      i++
    }
  }
  return new RegExp(`^${re}$`)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Recursively walk a directory, skipping IGNORE_DIRS. Returns relative file paths. */
async function walkDir(dir: string, base: string): Promise<string[]> {
  const results: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const sub = await walkDir(join(dir, entry.name), base)
      results.push(...sub)
    } else {
      results.push(relative(base, join(dir, entry.name)))
    }
  }
  return results
}

/**
 * glob tool: find files matching a glob pattern.
 * Permission: auto (read-only).
 */
export const globTool: ToolDef = {
  name: 'glob',
  description:
    'Find files matching a glob pattern. Supports *, **, ?, {a,b}. Searches recursively, skipping node_modules/.git/dist.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts").' },
      path: { type: 'string', description: 'Base directory to search (default: cwd).' },
    },
    required: ['pattern'],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { pattern, path } = input as GlobInput
    const basePath = path ? resolve(ctx.cwd, path) : ctx.cwd

    try {
      const regex = globToRegex(pattern)
      const files = await walkDir(basePath, basePath)
      const matched = files.filter((f) => regex.test(f)).sort()
      return {
        _tag: 'success',
        output: matched.join('\n'),
        metadata: { count: matched.length },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Glob failed: ${message}` }
    }
  },
}
