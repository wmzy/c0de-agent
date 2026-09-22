import { createHash } from 'node:crypto'

// hashline 补丁语言（spec §16）：内容哈希锚定的行级补丁。
// 本模块实现全部行级操作（SWAP/DEL/INS.PRE|POST|HEAD|TAIL）。
// BLK 语法块操作（spec §16.2）是未来项，依赖 tree-sitter AST，
// 与 ast_grep/ast_edit 工具共享同一依赖簇，统一在该里程碑实现。
// 当前 parseOps 遇到 `*.BLK` 操作会抛 `unknown operation`（硬错误，非静默 stub）。

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

/** 解析一个 `[path#hash]` 块内的操作序列。lines 为该块头之后的全部剩余行。
 *  返回 { ops, consumed }：consumed 是本次消费的行数（含块间分隔空行，
 *  不含下一块头行）——parsePatch 据此推进。
 *
 *  结构感知：块头只在「操作位置」生效——以 `---` 显式终止的操作，其内容里的
 *  任何行（含 [path#hash] 形行、操作语法形行）都是内容；`---` 缺失时以
 *  下一个操作行/块头为隐式边界。 */
function parseOps(lines: string[]): { ops: PatchOp[]; consumed: number } {
  const ops: PatchOp[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || line === '---') {
      i++
      continue
    }
    if (HEADER_RE.test(line.trim())) break // 下一块头：操作位置生效
    const tokens = line.split(/\s+/)
    const head = tokens[0]
    if (!head) throw new Error('hashline: empty operation line')

    // 候选边界行之后是否先出现 `---`：是则该候选行是内容（显式终止符
    // 优先于一切），否则该候选行就是边界。
    const isContentLine = (at: number): boolean => {
      for (let k = at + 1; k < lines.length; k++) {
        const lk = lines[k] ?? ''
        if (lk === '---') return true
        if (isOpLine(lk) || HEADER_RE.test(lk.trim())) return false
      }
      return false
    }

    // 收集到显式 `---`、或（无 `---` 时）到下一个操作行/块头/文件尾的内容行。
    const collectContent = (): { content: string; next: number } => {
      const body: string[] = []
      let j = i + 1
      while (j < lines.length) {
        const l = lines[j] ?? ''
        if (l === '---') return { content: body.join('\n'), next: j + 1 }
        if ((isOpLine(l) || HEADER_RE.test(l.trim())) && !isContentLine(j)) break
        body.push(l)
        j++
      }
      // 隐式终止（无 --- 的块）：块间分隔空行不是内容，剥离恰好一个
      //（内容里合法结尾空行由倒数第二个空串表达，与既有口径一致）。
      if (body.length > 0 && body[body.length - 1] === '') body.pop()
      return { content: body.join('\n'), next: j }
    }
    // DEL 无内容体：跳到显式 `---` 或下一个操作行/块头（无 --- 的多操作补丁
    // 里，后续操作不得被当「要跳过的内容」吞掉）。
    const skipToSeparator = (): number => {
      let j = i + 1
      while (j < lines.length) {
        const l = lines[j] ?? ''
        if (l === '---') return j + 1
        if (isOpLine(l) || HEADER_RE.test(l.trim())) return j
        j++
      }
      return j
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
      ops.push({ _tag: 'INS_PRE', line: parseLineNumber(tokens[1]), content })
      i = next
    } else if (head === 'INS.POST') {
      const { content, next } = collectContent()
      ops.push({ _tag: 'INS_POST', line: parseLineNumber(tokens[1]), content })
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
  return { ops, consumed: i }
}

/** 操作行的完整语法（用于内容边界判定；宽容行尾空白）。 */
const OP_LINE_RE =
  /^(?:SWAP|DEL)\s+\d+(?:-\d+)?\s*$|^INS\.(?:PRE|POST)\s+\d+\s*$|^INS\.(?:HEAD|TAIL)\s*$/

function isOpLine(line: string): boolean {
  return OP_LINE_RE.test(line)
}

/**
 * 解析 `start` 或 `start-end`，返回 [start, end?]（1-indexed 十进制整数）。
 * 非十进制整数（小数/十六进制/科学计数/尾随垃圾）显式抛错：Number('1.5') 会
 * 通过 inBounds 后被 splice 静默截断、Number('0x10')=16——垃圾行号静默命中错误行。
 */
function parseRange(spec: string | undefined): [number, number | undefined] {
  if (!spec) throw new Error('hashline: missing line range')
  const parts = spec.split('-')
  if (parts.length > 2 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`hashline: invalid line range "${spec}" (decimal integers expected)`)
  }
  return [Number(parts[0]), parts[1] !== undefined ? Number(parts[1]) : undefined]
}

/** 解析单行号（INS.PRE/POST 用），与 parseRange 同口径严格校验。 */
function parseLineNumber(spec: string | undefined): number {
  if (spec === undefined || !/^\d+$/.test(spec)) {
    throw new Error(`hashline: invalid line number "${spec ?? ''}" (decimal integer expected)`)
  }
  return Number(spec)
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
    // 结构感知解析：块头只会在「操作位置」终止上一个块——`---` 终止的操作
    // 其内容里的 [path#hash] 形行是内容而非新块（此前恒按块头扫描，合法
    // 内容被拦腰截断、残余行被当作操作解析报 unknown operation）。
    const { ops, consumed } = parseOps(lines.slice(i + 1))
    patches.push({ path, hash, operations: ops })
    i = i + 1 + consumed
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
  // CRLF 行尾：行 token 剥离 \r 参与行算术，输出按检测到的行尾重建。
  // 此前 split('\n') 后行内残留 \r——SWAP 替换整行（含其 \r）、INS 插入行
  // 用 \n 连接，编辑/插入行静默丢失 \r，与未触碰行混成 CRLF/LF 混合行尾。
  // 无 \n 的孤立 \r（LF 判定下）是文件内容而非行尾，保持原样。
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const stripCR = (l: string): string => (l.endsWith('\r') ? l.slice(0, -1) : l)
  const lines = src.split('\n').map((l) => (eol === '\r\n' ? stripCR(l) : l))
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
    // 补丁内容行按文件行尾归一：模型若粘贴了 CRLF 内容，先剥 \r 再按 eol 重建，
    // 与文件其余部分保持单一换行风格。
    const contentLines =
      'content' in op && op.content !== ''
        ? op.content.split('\n').map((l) => (eol === '\r\n' ? stripCR(l) : l))
        : []
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

  let result = lines.join(eol)
  if (hadTrailingNewline) result += eol
  return { _tag: 'success', content: result }
}

export type { ApplyResult, ParsedPatch, PatchOp }
export { applyPatch, computeHash, parsePatch }
