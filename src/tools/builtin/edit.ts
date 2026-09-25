import { readFile, writeFile } from 'node:fs/promises'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { safeResolve } from '../../shared/utils/path.js'
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
    const fullPath = safeResolve(ctx.cwd, path)
    if (fullPath === null) {
      return { _tag: 'error', error: `Path "${path}" escapes the working directory` }
    }

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
      // CRLF 行尾一并折叠：\r 对模型不可见，模型生成的 oldText 恒用 \n——
      // 不折叠则 \n 版 oldText 在 CRLF 文件上恒不匹配（「oldText not found」）。
      // 折叠后的位置经 buildPositionMapping 映射回原文（\r 按「原文多余空白」跳过）。
      const normalize = (s: string): string => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ')

      const normalizedContent = normalize(content)
      const normalizedOld = normalize(oldText)

      // 空 oldText 会让 indexOf('') 恒命中同一位置、searchFrom 永不前进——
      // matches 推到 2^32 溢出（RangeError）前烧数秒 CPU 且报错无法指导模型。
      if (normalizedOld.length === 0) {
        return { _tag: 'error', error: `edit: oldText must not be empty for "${path}"` }
      }

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

      const newContent = (() => {
        // 映射起点可能落在 CRLF 对中间：区域以 \n 开头时（normalize 把 \r\n 折成
        // \n，映射把原文的 \r 当作「多余空白」跳过），前一行的 \r 留在区域外，
        // 而 replacement 自带 \r\n → 拼成「\r\r\n」（孤立回车 + 原行尾被吃）；
        // replacement 不含换行时 \r 更会留在行中（"line1\rX"）。与末尾守卫对称：
        // 起点落在 CRLF 对中间时把 \r 纳入区域。
        let start = origStart
        if (start > 0 && content[start - 1] === '\r' && content[start] === '\n') start--
        // 映射终点可能落在 CRLF 中间（region 吞入 \r，行尾 \n 留在区域外）：
        // 把 \r 让回外部行尾，否则单行替换会产出「替换文本\n」丢失 \r 的混合行尾。
        let end = origEnd
        if (end < content.length && content[end - 1] === '\r' && content[end] === '\n') end--
        // 行尾口径按**文件主导行尾**判定（与 hashline 模式/grep/shake/workflows 同口径）。
        // 只看被替换区域是否含 CRLF 会在「单行区域 + 多行 newText」漏判——区域本身
        // 不含换行，newText 的 \n 原样写入 CRLF 文件，产出混合行尾（git diff 全行噪音）。
        // LF 文件同理：newText 里的 \r\n（模型粘贴 Windows 文本）此前原样写入，
        // 与其余行混成混合行尾——两个方向都要归一（与 hashline 的同型修复一致）。
        const replacement = content.includes('\r\n')
          ? newText.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
          : newText.replace(/\r\n/g, '\n')
        return content.slice(0, start) + replacement + content.slice(end)
      })()
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
 *
 * normalize 的两条折叠规则各自需要**专门**的推进分支（此前只有一个「原文是空白
 * 就只推进原文指针」的分支，掩盖了两条规则的区别）：
 *  - `\r\n` → `\n`：原文的 \r 不产出任何 normalized 字符，只推进原文指针；
 *  - `[ \t]+` → `' '`：原文整个空白 run 只产出**一个**空格，必须连同 normalized
 *    侧的那个空格一起消费。
 * 缺第二个分支时，run 首字符是空格（与 normalized 的空格相等，走对齐分支）、
 * 其余空格走「只推进原文」分支，恰好正确；而 run 首字符是 tab 时首个不对齐处
 * 落进「理论不可达」的兜底分支（两侧同时推进），此后整串错位一格——匹配区终点
 * 落到目标之后，替换连紧随的换行与下一行首字符一起吃掉（静默源码损坏，工具
 * 仍报 success）。
 */
function buildPositionMapping(original: string, normalized: string): Map<number, number> {
  const map = new Map<number, number>()
  let origIdx = 0
  let normIdx = 0

  while (origIdx < original.length && normIdx < normalized.length) {
    map.set(normIdx, origIdx)
    const origChar = original[origIdx]
    const normChar = normalized[normIdx]

    if (origChar === normChar) {
      origIdx++
      normIdx++
      continue
    }
    // \r：CRLF 行尾在 normalize 中被折叠为 \n——映射时原文的 \r 是
    // 「原文多余的空白」，仅前进原文指针（normIdx 停住等 \n 对齐）。
    if (origChar === '\r') {
      origIdx++
      continue
    }
    // 空白 run 折叠为单个空格：吃掉整个 run，同时消费 normalized 侧的那个空格。
    if (normChar === ' ' && (origChar === ' ' || origChar === '\t')) {
      while (
        origIdx < original.length &&
        (original[origIdx] === ' ' || original[origIdx] === '\t')
      ) {
        origIdx++
      }
      normIdx++
      continue
    }
    // run 的后续空白（normalized 侧无对应字符）：只推进原文指针。
    if (origChar === ' ' || origChar === '\t') {
      origIdx++
      continue
    }
    // 理论上不可达（normalize 后两侧应逐字符对齐）：保守同步推进，绝不抛错。
    origIdx++
    normIdx++
  }
  // Map the end position
  map.set(normIdx, origIdx)
  return map
}
