import { readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { IGNORED_DIR_NAMES } from '../../shared/utils/path.js'
import { escapeRegex } from '../../shared/utils/string.js'
import type { GrepInput, GrepMatch } from '../types.js'
import { resolveToolPath } from './paths.js'
import { walkFiles } from './walk.js'

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

/** 构造内容搜索正则（本工具与 workflows/context.ts 的 grepRecursive 共用——
 *  正则构造与 CRLF 行尾归一化此前两处各持一份，语义各自演化）。
 *  非法模式默认上抛（工具路径报错供模型自纠）；literalFallback=true 时回退为
 *  逐字符转义的字面量匹配（utils.grep 的历史口径：工作流作者写错正则不至于
 *  让整个 run 崩溃）。 */
export function buildGrepRegex(
  pattern: string,
  opts: { caseSensitive?: boolean; literalFallback?: boolean } = {},
): RegExp {
  const flags = opts.caseSensitive === false ? 'i' : ''
  try {
    return new RegExp(pattern, flags)
  } catch (err) {
    if (opts.literalFallback) return new RegExp(escapeRegex(pattern), flags)
    throw err
  }
}

/** 按内容拆行并做 CRLF 规范化：文件主导行尾为 \r\n 时剥离行尾 \r——否则
 *  ^...$ / \w+$ 等锚定到行尾的正则全部在 \r 上失败，命中行静默归零。孤立 \r
 *  （旧 Mac 行尾）不触碰（与 shake/hashline 同型）。 */
export function splitGrepLines(content: string): string[] {
  const lines = content.split('\n')
  if (!content.includes('\r\n')) return lines
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** Recursively walk a directory for text files. */
async function walkForFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  await walkFiles(dir, { skipDir: (name) => IGNORED_DIR_NAMES.has(name) }, (fullPath, name) => {
    // 无扩展名（lastIndexOf 返回 -1）时 ext 须为 ''：此前 slice(-1) 取到名字
    // 最后一个字符，ext === '' 分支成死代码，Dockerfile/Makefile/README 等
    // 无扩展名文本文件被静默跳过。
    const dot = name.lastIndexOf('.')
    const ext = dot === -1 ? '' : name.slice(dot)
    if (TEXT_EXTENSIONS.has(ext) || ext === '') {
      results.push(fullPath)
    }
  })
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
    const basePath = resolveToolPath(ctx, path)
    if (typeof basePath !== 'string') return basePath

    let regex: RegExp
    try {
      regex = buildGrepRegex(pattern, { caseSensitive })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Invalid regex pattern: ${message}` }
    }

    try {
      const files = await walkForFiles(basePath)
      const matches: GrepMatch[] = []
      const max = maxResults
      // 读取失败（权限不可读/悬空符号链接/删除竞态）的文件数：单文件失败只
      // 跳过该文件，绝不中断整个搜索（与 walkForFiles 对 readdir 失败的
      // 容错同口径），但计数并显式回报——静默跳过会让模型误判「仓库里没有」。
      let unreadableFiles = 0

      outer: for (const filePath of files) {
        // 先 stat 再读：大小上限的语义是「跳过 >1MB 文件」，此前先 readFile
        // 再查长度——整个大文件已被读进内存才丢弃（仓库里一个 GB 级文件即可
        // 让 grep 读取数 GB），且超限且不可读的文件会因先读而 EACCES 失败。
        const info = await stat(filePath).catch(() => null)
        if (info === null || info.size > MAX_FILE_SIZE) continue
        const content = await readFile(filePath, 'utf-8').catch(() => {
          unreadableFiles += 1
          return null
        })
        if (content === null) continue
        const lines = splitGrepLines(content)
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

      const skippedNote =
        unreadableFiles > 0 ? `\n[${unreadableFiles} unreadable file(s) skipped]` : ''
      const output = matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n') + skippedNote

      return {
        _tag: 'success',
        output,
        metadata: {
          count: matches.length,
          truncated: matches.length >= max,
          ...(unreadableFiles > 0 ? { unreadableFiles } : {}),
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { _tag: 'error', error: `Grep failed: ${message}` }
    }
  },
}
