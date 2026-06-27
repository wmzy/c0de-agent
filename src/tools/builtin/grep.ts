import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import type { GrepInput, GrepMatch } from '../types.js'

/** Directories always skipped during search. */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.turbo'])

/** File extensions treated as text (skip binary files). */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx',
  '.txt', '.css', '.scss', '.html', '.htm', '.xml', '.yaml', '.yml',
  '.toml', '.ini', '.env', '.sh', '.bash', '.zsh', '.py', '.rb', '.go',
  '.rs', '.java', '.kt', '.c', '.cpp', '.h', '.hpp', '.cs', '.php',
  '.swift', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.astro',
])

/** Maximum file size to search (skip files > 1MB). */
const MAX_FILE_SIZE = 1024 * 1024

/** Recursively walk a directory for text files. */
async function walkForFiles(dir: string, base: string): Promise<string[]> {
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
      const sub = await walkForFiles(join(dir, entry.name), base)
      results.push(...sub)
    } else {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'))
      if (TEXT_EXTENSIONS.has(ext) || ext === '') {
        results.push(join(dir, entry.name))
      }
    }
  }
  return results
}

/**
 * grep tool: search file contents with regex.
 * Permission: auto (read-only).
 */
export const grepTool: ToolDef = {
  name: 'grep',
  description:
    'Search file contents using regex. Searches recursively across text files, skipping node_modules/.git. Returns matching lines with file and line number.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression pattern.' },
      path: { type: 'string', description: 'Base directory to search (default: cwd).' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive search (default: true).' },
      maxResults: { type: 'number', description: 'Maximum number of matches to return.' },
    },
    required: ['pattern'],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { pattern, path, caseSensitive = true, maxResults = 200 } = input as GrepInput
    const basePath = path ? resolve(ctx.cwd, path) : ctx.cwd

    let regex: RegExp
    try {
      regex = new RegExp(pattern, caseSensitive ? '' : 'i')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Invalid regex pattern: ${message}` }
    }

    try {
      const files = await walkForFiles(basePath, basePath)
      const matches: GrepMatch[] = []
      const max = maxResults

      outer: for (const filePath of files) {
        const stat = await readFile(filePath)
        if (stat.length > MAX_FILE_SIZE) continue

        const content = stat.toString('utf-8')
        const lines = content.split('\n')
        const relPath = relative(basePath, filePath)

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          const match = line.match(regex)
          if (match) {
            matches.push({
              file: relPath,
              line: i + 1,
              text: line.trim(),
              match: match[0] ?? '',
            })
            if (matches.length >= max) break outer
          }
        }
      }

      const output = matches
        .map((m) => `${m.file}:${m.line}: ${m.text}`)
        .join('\n')

      return {
        _tag: 'success',
        output,
        metadata: { count: matches.length, truncated: matches.length >= max },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Grep failed: ${message}` }
    }
  },
}
