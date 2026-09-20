import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { safeResolve } from '../../shared/utils/path.js'
import type { GlobInput } from '../types.js'

/** Directories always skipped during glob traversal. */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.turbo'])

/**
 * Convert a glob pattern to a RegExp.
 * Supports: * (single segment), ** (across segments), ? (single char), {a,b} (alternation), [abc] (char class).
 */
export function globToRegex(pattern: string): RegExp {
  return new RegExp(`^${globFragment(pattern)}$`)
}

/** 把字面量文本转义为正则原文（用于降级路径：非法字符类/含空分支的花括号）。 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Convert a glob fragment (may appear inside brace alternation) to regex source.
 *  Recursive so wildcards inside {a,b} stay wildcards instead of being escaped
 *  as literals（此前 {*.spec.ts,*.test.ts} 恒不匹配任何文件）。 */
function globFragment(pattern: string): string {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i] ?? ''
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
        const alts = inner.split(',')
        // 空分支（{a,}）会生成空交替 (?:a|)——空串匹配一切，静默过匹配。
        // 含空分支整体降级为字面量（宁可零命中，不可命中一切）。
        if (alts.some((alt) => alt.length === 0)) {
          re += `\\{${escapeRegex(inner)}\\}`
        } else {
          re += `(?:${alts.map(globFragment).join('|')})`
        }
        i = end + 1
      }
    } else if (c === '[') {
      // 类首 ] 是字面量成员（bash 口径：[]a] 匹配 ] 或 a）——跳过后找真正的闭合。
      let end = pattern.indexOf(']', i)
      if (end === i + 1) {
        const realEnd = pattern.indexOf(']', i + 2)
        if (realEnd !== -1) end = realEnd
      }
      if (end === -1) {
        re += '\\['
        i++
      } else {
        const inner = pattern.slice(i + 1, end)
        // [] 在 JS 是「空类恒不匹配」（合法但不产生任何命中）——语义为字面量。
        if (inner === '') {
          re += '\\[\\]'
          i = end + 1
          continue
        }
        // glob 取反语义：类首 ! 转为正则 ^；类首 ^ 在 bash 口径是字面量，
        // 必须转义，否则被 JS 解释为取反（[!0-9]/[^a] 均曾静默语义反转）。
        let cls = inner
        if (cls.startsWith('!')) {
          // 单独 [!]：取反空类在正则中是 [^]（匹配一切）——保持普通单成员类。
          if (cls.length === 1) {
            cls = '!'
          } else {
            cls = `^${cls.slice(1)}`
          }
        } else if (cls.startsWith('^')) {
          cls = `\\^${cls.slice(1)}`
        } else if (cls.startsWith(']')) {
          cls = `\\]${cls.slice(1)}`
        }
        // 退化类（反向区间 [z-a] 等）此前直接拼进 new RegExp 抛 SyntaxError
        // 击穿工具调用——探测编译失败时按字面量降级，绝不抛出。
        try {
          new RegExp(`^[${cls}]$`)
          re += `[${cls}]`
        } catch {
          re += `\\[${escapeRegex(inner)}\\]`
        }
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
  return re
}

/** Recursively walk a directory, skipping IGNORE_DIRS. Returns relative file paths. */
async function walkDir(dir: string, base: string): Promise<string[]> {
  const results: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!entries) return []
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
    // 与 read/write/edit 同口径：path 必须落在 cwd 内——permission 是 auto，
    // 若放行绝对路径/../，模型可在无确认下枚举工作目录外（如 ~/.ssh）。
    const basePath = path ? safeResolve(ctx.cwd, path) : ctx.cwd
    if (basePath === null) {
      return { _tag: 'error', error: `Path "${path}" escapes the working directory` }
    }

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
