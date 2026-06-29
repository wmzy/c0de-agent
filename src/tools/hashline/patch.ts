import { createHash } from 'node:crypto'

// hashline 补丁语言（spec §16）：内容哈希锚定的行级补丁。
// 本模块仅实现行级操作（SWAP/DEL/INS.PRE|POST|HEAD|TAIL）；
// BLK 语法块操作（spec §16.2）依赖 tree-sitter AST，随 AST 工具后续迭代。

// ── 操作类型 ──────────────────────────────────────────────

type PatchOp =
  | { _tag: 'SWAP'; start: number; end: number; content: string }
  | { _tag: 'DEL'; start: number; end: number }
  | { _tag: 'INS_PRE'; line: number; content: string }
  | { _tag: 'INS_POST'; line: number; content: string }
  | { _tag: 'INS_HEAD'; content: string }
  | { _tag: 'INS_TAIL'; content: string }

type ParsedPatch = { path: string; hash: string; operations: PatchOp[] }

type ApplyResult =
  | { _tag: 'success'; content: string }
  | { _tag: 'hash_mismatch'; expected: string; actual: string }
  | { _tag: 'line_not_found'; operation: PatchOp }

// ── computeHash ──────────────────────────────────────────

/** 4 位 hex 内容哈希（sha256 取前 4 位）。与 session 快照哈希算法同源。 */
function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 4)
}

// ── parsePatch ───────────────────────────────────────────

const HEADER_RE = /^\[(.+?)#([0-9a-fA-F]+)\]\s*$/

/** 解析一个 `[path#hash]` 块内的操作序列。lines 为该块头之后的行。 */
function parseOps(lines: string[]): PatchOp[] {
  const ops: PatchOp[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line || line.trim() === '') {
      i++
      continue
    }
    const tokens = line.split(/\s+/)
    const head = tokens[0]
    if (!head) throw new Error('hashline: empty operation line')

    // 收集到下一个分隔符 `---`（或块尾）的内容行
    const collectContent = (): { content: string; next: number } => {
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && lines[j] !== '---') {
        body.push(lines[j] ?? '')
        j++
      }
      return { content: body.join('\n'), next: j + 1 }
    }
    // 无内容体（DEL）也吃掉到 `---`
    const skipToSeparator = (): number => {
      let j = i + 1
      while (j < lines.length && lines[j] !== '---') j++
      return j + 1
    }

    if (head === 'SWAP') {
      const [s, e] = parseRange(tokens[1])
      const { content, next } = collectContent()
      ops.push({ _tag: 'SWAP', start: s, end: e ?? s, content })
      i = next
    } else if (head === 'DEL') {
      const [s, e] = parseRange(tokens[1])
      ops.push({ _tag: 'DEL', start: s, end: e ?? s })
      i = skipToSeparator()
    } else if (head === 'INS.PRE') {
      const { content, next } = collectContent()
      ops.push({ _tag: 'INS_PRE', line: Number(tokens[1]), content })
      i = next
    } else if (head === 'INS.POST') {
      const { content, next } = collectContent()
      ops.push({ _tag: 'INS_POST', line: Number(tokens[1]), content })
      i = next
    } else if (head === 'INS.HEAD') {
      const { content, next } = collectContent()
      ops.push({ _tag: 'INS_HEAD', content })
      i = next
    } else if (head === 'INS.TAIL') {
      const { content, next } = collectContent()
      ops.push({ _tag: 'INS_TAIL', content })
      i = next
    } else {
      throw new Error(`hashline: unknown operation "${head}"`)
    }
  }
  return ops
}

/** 解析 `start` 或 `start-end`，返回 [start, end?]（1-indexed）。 */
function parseRange(spec: string | undefined): [number, number | undefined] {
  if (!spec) throw new Error('hashline: missing line range')
  if (spec.includes('-')) {
    const [a, b] = spec.split('-')
    return [Number(a), Number(b)]
  }
  return [Number(spec), undefined]
}

/** 解析补丁文本为一个或多个 ParsedPatch（按 `[path#hash]` 头分块）。 */
function parsePatch(input: string): ParsedPatch[] {
  const lines = input.split('\n')
  const patches: ParsedPatch[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line || line.trim() === '') {
      i++
      continue
    }
    const m = HEADER_RE.exec(line)
    if (!m) throw new Error(`hashline: malformed header "${line}"`)
    const path = m[1] ?? ''
    const hash = m[2] ?? ''
    const block = lines.slice(i + 1)
    const endIdx = block.indexOf('') // 块以空行或文件尾分隔（其实下一头才分隔）
    // 操作持续到下一个头或文件尾：找到下一个 HEADER_RE 匹配行
    let nextHead = block.length
    for (let k = 0; k < block.length; k++) {
      if (HEADER_RE.test((block[k] ?? '').trim())) {
        nextHead = k
        break
      }
    }
    void endIdx
    const opsLines = block.slice(0, nextHead)
    patches.push({ path, hash, operations: parseOps(opsLines) })
    i = i + 1 + nextHead
  }
  return patches
}

// ── applyPatch ───────────────────────────────────────────

/** 每个操作基于原文件的"锚点行号"，用于排序使从后往前应用。 */
function anchor(op: PatchOp, lineCount: number): number {
  switch (op._tag) {
    case 'SWAP':
    case 'DEL':
      return op.start
    case 'INS_PRE':
      return op.line
    case 'INS_POST':
      return op.line + 1
    case 'INS_HEAD':
      return 1
    case 'INS_TAIL':
      return lineCount + 1
  }
}

/** 校验操作的行号范围是否落在 [1, lineCount]。 */
function inBounds(op: PatchOp, lineCount: number): boolean {
  switch (op._tag) {
    case 'SWAP':
    case 'DEL':
      return op.start >= 1 && op.end <= lineCount && op.start <= op.end
    case 'INS_PRE':
    case 'INS_POST':
      return op.line >= 1 && op.line <= lineCount
    case 'INS_HEAD':
    case 'INS_TAIL':
      return true
  }
}

/** 应用一个补丁到文件内容。先校验哈希，再按锚点降序应用操作。 */
function applyPatch(file: string, patch: ParsedPatch): ApplyResult {
  const actual = computeHash(file)
  if (actual !== patch.hash) {
    return { _tag: 'hash_mismatch', expected: patch.hash, actual }
  }

  // 末尾换行保留策略：按 \n 拆分，末尾空串代表文件以换行结尾。
  const hadTrailingNewline = file.endsWith('\n')
  const src = hadTrailingNewline ? file.slice(0, -1) : file
  const lines = src.split('\n')
  const lineCount = lines.length

  // 先全部校验范围，任一越界即 line_not_found（保持原文件不变）
  for (const op of patch.operations) {
    if (!inBounds(op, lineCount)) {
      return { _tag: 'line_not_found', operation: op }
    }
  }

  // 按锚点降序应用：高行号先改，低行号锚点不受影响
  const ordered = [...patch.operations].sort((a, b) => {
    const lineCountFinal = lineCount
    return anchor(b, lineCountFinal) - anchor(a, lineCountFinal)
  })

  for (const op of ordered) {
    const contentLines = 'content' in op && op.content !== '' ? op.content.split('\n') : []
    switch (op._tag) {
      case 'SWAP':
        lines.splice(op.start - 1, op.end - op.start + 1, ...contentLines)
        break
      case 'DEL':
        lines.splice(op.start - 1, op.end - op.start + 1)
        break
      case 'INS_PRE':
        lines.splice(op.line - 1, 0, ...contentLines)
        break
      case 'INS_POST':
        lines.splice(op.line, 0, ...contentLines)
        break
      case 'INS_HEAD':
        lines.unshift(...contentLines)
        break
      case 'INS_TAIL':
        lines.push(...contentLines)
        break
    }
  }

  let result = lines.join('\n')
  if (hadTrailingNewline) result += '\n'
  return { _tag: 'success', content: result }
}

export type { ApplyResult, ParsedPatch, PatchOp }
export { applyPatch, computeHash, parsePatch }
