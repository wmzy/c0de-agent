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

/** 找到与 pattern[start]（'{'）配对的 '}'，计嵌套深度；未配对返回 -1。
 *  此前用 indexOf('}') 只取第一个——{a,{b,c}} 被截到内层的 }，内层分支降级为
 *  字面量，b/c 静默零命中。 */
function findBraceEnd(pattern: string, start: number): number {
  let depth = 0
  for (let i = start; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 按顶层逗号切分花括号内容：嵌套花括号与字符类内的逗号属于内层，不参与切分。
 *  字符类按 []a] 口径跳过类首字面量 ]（与 globFragment 的类解析同源）。 */
function splitBraceAlternatives(inner: string): string[] {
  const alts: string[] = []
  let depth = 0
  let inClass = false
  let current = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] ?? ''
    if (inClass) {
      if (c === ']') inClass = false
      current += c
      continue
    }
    if (c === '[') {
      inClass = true
      current += c
      if (inner[i + 1] === ']') {
        current += ']'
        i++
      }
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth--
    if (c === ',' && depth === 0) {
      alts.push(current)
      current = ''
      continue
    }
    current += c
  }
  alts.push(current)
  return alts
}

/** Convert a glob fragment (may appear inside brace alternation) to regex source.
 *  Recursive so wildcards inside {a,b} stay wildcards instead of being escaped
 *  as literals（此前 {*.spec.ts,*.test.ts} 恒不匹配任何文件）。
 *  segStartAt0：fragment 起始位置是否算「段起点」——顶层模式为真；花括号分支
 *  按分支前一个字符是否为 / 传入（{/**,x} 中的 ** 才是完整段）。 */
function globFragment(pattern: string, segStartAt0 = true): string {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i] ?? ''
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const prev = pattern[i - 1]
        const next = pattern[i + 2]
        // 双星只在「完整段」（前后均无普通字符）时才有跨目录语义（bash globstar）。
        const segStart = i === 0 ? segStartAt0 : prev === '/'
        const segEnd = next === undefined || next === '/'
        if (segStart && segEnd) {
          if (next === '/') {
            // **/ 整体表达「零或多个段」：恒译 .* 会把 a/**/b 译成 a/.*b，
            // 命中 a/xb、**/b 命中 foob（段边界失守）。
            re += '(?:.*/)?'
            i += 3
          } else {
            re += '.*'
            i += 2
          }
        } else {
          // 非段对齐的双星（a**b、**.ts）塌缩为单星，不跨目录。
          re += '[^/]*'
          i += 2
        }
      } else {
        re += '[^/]*'
        i++
      }
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if (c === '{') {
      const end = findBraceEnd(pattern, i)
      if (end === -1) {
        re += '\\{'
        i++
      } else {
        const inner = pattern.slice(i + 1, end)
        const alts = splitBraceAlternatives(inner)
        // 空分支（{a,}）会生成空交替 (?:a|)——空串匹配一切，静默过匹配。
        // 含空分支整体降级为字面量（宁可零命中，不可命中一切）。
        if (alts.some((alt) => alt.length === 0)) {
          re += `\\{${escapeRegex(inner)}\\}`
        } else {
          const fragStartSeg = i === 0 ? segStartAt0 : pattern[i - 1] === '/'
          re += `(?:${alts.map((alt) => globFragment(alt, fragStartSeg)).join('|')})`
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
