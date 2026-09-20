import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { safeResolve } from '../../shared/utils/path.js'
import type { GrepInput, GrepMatch } from '../types.js'

/** Directories always skipped during search. */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.turbo'])

/** File extensions treated as text (skip binary files). */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.mdx',
  '.txt',
  '.css',
  '.scss',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.swift',
  '.sql',
  '.graphql',
  '.gql',
  '.vue',
  '.svelte',
  '.astro',
])

/** Maximum file size to search (skip files > 1MB). */
const MAX_FILE_SIZE = 1024 * 1024

/** Recursively walk a directory for text files. */
async function walkForFiles(dir: string, base: string): Promise<string[]> {
  const results: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!entries) return []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      const sub = await walkForFiles(join(dir, entry.name), base)
      results.push(...sub)
    } else {
      // 无扩展名（lastIndexOf 返回 -1）时 ext 须为 ''：此前 slice(-1) 取到名字
      // 最后一个字符，ext === '' 分支成死代码，Dockerfile/Makefile/README 等
      // 无扩展名文本文件被静默跳过。
      const dot = entry.name.lastIndexOf('.')
      const ext = dot === -1 ? '' : entry.name.slice(dot)
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
      maxResults: { type: 'integer', description: 'Maximum number of matches to return.' },
    },
    required: ['pattern'],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    const { pattern, path, caseSensitive = true, maxResults = 200 } = input as GrepInput
    // maxResults <= 0 会让「matches.length >= max」在首个匹配后立即成立，
    // 静默返回 1 条且 truncated:true（语义应为最多 N 条）。
    // Infinity（1e999）使比较恒 false、上限静默失效；小数语义无定义。
    // 显式报错供模型自纠。
    if (!Number.isInteger(maxResults) || maxResults < 1) {
      return {
        _tag: 'error',
        error: `grep: maxResults must be an integer >= 1, got ${maxResults}`,
      }
    }
    // 与 read/write/edit 同口径：path 必须落在 cwd 内——permission 是 auto，
    // 若放行绝对路径/../，模型可在无确认下读取工作目录外文件内容（如 ~/.ssh）。
    const basePath = path ? safeResolve(ctx.cwd, path) : ctx.cwd
    if (basePath === null) {
      return { _tag: 'error', error: `Path "${path}" escapes the working directory` }
    }

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
          const line = lines[i] ?? ''
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

      const output = matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n')

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
