import { describe, expect, it } from 'vitest'
import { applyPatch, computeHash, type ParsedPatch, parsePatch } from './patch.js'

function firstPatch(patches: ParsedPatch[]): ParsedPatch {
  if (!patches[0]) throw new Error('expected at least one patch')
  return patches[0]
}

// hashline 补丁语言（spec §16）：内容哈希锚定的行级补丁，BLK 语法块操作待 AST。

describe('computeHash', () => {
  it('returns 4-char hex', () => {
    const h = computeHash('hello')
    expect(h).toMatch(/^[0-9a-f]{4}$/)
  })

  it('is deterministic for identical content', () => {
    expect(computeHash('abc\n')).toBe(computeHash('abc\n'))
  })

  it('differs for different content', () => {
    expect(computeHash('abc')).not.toBe(computeHash('abd'))
  })
})

describe('parsePatch', () => {
  it('parses header + single SWAP op', () => {
    const src = '[src/main.ts#a1b2]\nSWAP 1-2\nnew a\nnew b\n---\n'
    const patches = parsePatch(src)
    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual({
      path: 'src/main.ts',
      hash: 'a1b2',
      operations: [{ _tag: 'SWAP', start: 1, end: 2, content: 'new a\nnew b' }],
    })
  })

  it('parses DEL op (single line)', () => {
    const patches = parsePatch('[f.ts#0000]\nDEL 3\n---\n')
    expect(patches[0]?.operations).toEqual([{ _tag: 'DEL', start: 3, end: 3 }])
  })

  it('parses DEL op (range)', () => {
    const patches = parsePatch('[f.ts#0000]\nDEL 2-4\n---\n')
    expect(patches[0]?.operations).toEqual([{ _tag: 'DEL', start: 2, end: 4 }])
  })

  it('parses INS.PRE / INS.POST', () => {
    const patches = parsePatch('[f.ts#0000]\nINS.PRE 2\nbefore\n---\nINS.POST 2\nafter\n---\n')
    expect(patches[0]?.operations).toEqual([
      { _tag: 'INS_PRE', line: 2, content: 'before' },
      { _tag: 'INS_POST', line: 2, content: 'after' },
    ])
  })

  it('parses INS.HEAD / INS.TAIL', () => {
    const patches = parsePatch('[f.ts#0000]\nINS.HEAD\ntop\n---\nINS.TAIL\nbottom\n---\n')
    expect(patches[0]?.operations).toEqual([
      { _tag: 'INS_HEAD', content: 'top' },
      { _tag: 'INS_TAIL', content: 'bottom' },
    ])
  })

  // 回归：补丁省略 `---`（块尾终止，解析器显式支持的路径）时，split('\n') 的
  // 尾部空串被 collectContent 收进最后一个操作的内容——SWAP 多替换一行空行、
  // INS.* 多插入一行空行，模型编辑的文件静默累积幽灵空行。
  it('content at block end (no ---) does not gain a phantom trailing empty line', () => {
    const patches = parsePatch('[f.ts#0000]\nSWAP 1-1\nX\n')
    expect(patches[0]?.operations).toEqual([{ _tag: 'SWAP', start: 1, end: 1, content: 'X' }])
  })

  it('multi-block separated by blank lines (no ---) keeps content clean', () => {
    const patches = parsePatch('[a.ts#0000]\nSWAP 1-1\nX\n\n[b.ts#1111]\nINS.TAIL\nY\n')
    expect(patches[0]?.operations).toEqual([{ _tag: 'SWAP', start: 1, end: 1, content: 'X' }])
    expect(patches[1]?.operations).toEqual([{ _tag: 'INS_TAIL', content: 'Y' }])
  })

  it('parses multiple patch blocks', () => {
    const patches = parsePatch('[a.ts#1111]\nDEL 1\n---\n[b.ts#2222]\nDEL 2\n---\n')
    expect(patches).toHaveLength(2)
    expect(patches[0]?.path).toBe('a.ts')
    expect(patches[1]?.path).toBe('b.ts')
  })

  it('throws on malformed header', () => {
    expect(() => parsePatch('not a header\nDEL 1\n---\n')).toThrow()
  })

  // 回归：Number('1.5') 通过 inBounds 后被 splice 静默截断、Number('0x10')=16、
  // Number('1e2')=100——垃圾行号静默命中错误行。行号必须是十进制整数。
  it('throws on non-integer line numbers', () => {
    expect(() => parsePatch('[a.ts#abcd]\nSWAP 1.5-2\nx\n---\n')).toThrow()
    expect(() => parsePatch('[a.ts#abcd]\nINS.PRE 1.5\nx\n---\n')).toThrow()
    expect(() => parsePatch('[a.ts#abcd]\nSWAP 0x10\ny\n---\n')).toThrow()
    expect(() => parsePatch('[a.ts#abcd]\nDEL 1e2\n---\n')).toThrow()
  })

  // 回归：SWAP 内容里的 `[path#hash]` 形行被块头扫描误判为新块——内容被
  // 拦腰截断、残余行被当作操作解析（unknown operation 抛错），以 --- 终止的
  // 操作内任何行都是内容，不得参与块头判定。
  it('SWAP content line looking like a block header stays content (--- terminated)', () => {
    const patches = parsePatch('[f.ts#abcd]\nSWAP 1-1\n[a.md#1234]\nsecond line\n---\n')
    expect(patches).toHaveLength(1)
    expect(patches[0]?.operations).toEqual([
      { _tag: 'SWAP', start: 1, end: 1, content: '[a.md#1234]\nsecond line' },
    ])
  })

  it('INS.TAIL content containing a header-like line stays content (--- terminated)', () => {
    const patches = parsePatch('[f.ts#abcd]\nINS.TAIL\n[x.ts#2222]\n---\n')
    expect(patches[0]?.operations).toEqual([{ _tag: 'INS_TAIL', content: '[x.ts#2222]' }])
  })

  // 回归：省略 --- 的多操作补丁里，DEL 会把后续操作行当「要跳过的内容」整体
  // 吞掉——INS.TAIL 静默不执行，文件只删不增，工具仍报成功。
  it('DEL without --- does not swallow the following operation', () => {
    const patches = parsePatch('[f.ts#0000]\nDEL 2\nINS.TAIL\nX\n')
    expect(patches[0]?.operations).toEqual([
      { _tag: 'DEL', start: 2, end: 2 },
      { _tag: 'INS_TAIL', content: 'X' },
    ])
  })

  // 回归：省略 --- 的多操作补丁里，SWAP 把后续操作行整段吸进替换内容，
  // 原定操作静默变成「写入一条操作语法文本」。
  it('SWAP without --- stops its content at the next operation line', () => {
    const patches = parsePatch('[f.ts#0000]\nSWAP 1-1\nA\nDEL 3\nINS.HEAD\nH\n')
    expect(patches[0]?.operations).toEqual([
      { _tag: 'SWAP', start: 1, end: 1, content: 'A' },
      { _tag: 'DEL', start: 3, end: 3 },
      { _tag: 'INS_HEAD', content: 'H' },
    ])
  })

  // 回归：`---` 只做全等比较——尾随空白（`--- `、`---\t`）/缩进（` --- `）变体
  // 被收进替换内容（文件凭空多出 "--- " 一行），后续操作静默变成内容/被跳过，
  // 工具仍报 success。空白变体与 `---` 视觉等价，必须是同一终止符。
  it('treats whitespace-padded --- as a separator, not content', () => {
    const patches = parsePatch('[f.ts#0000]\nSWAP 1-1\nX\n--- \nDEL 3\n')
    expect(patches[0]?.operations).toEqual([
      { _tag: 'SWAP', start: 1, end: 1, content: 'X' },
      { _tag: 'DEL', start: 3, end: 3 },
    ])
    const indented = parsePatch('[f.ts#0000]\nSWAP 1-1\nX\n --- \nDEL 3\n')
    expect(indented[0]?.operations).toEqual([
      { _tag: 'SWAP', start: 1, end: 1, content: 'X' },
      { _tag: 'DEL', start: 3, end: 3 },
    ])
  })
})

describe('applyPatch', () => {
  it('applies SWAP when hash matches', () => {
    const file = 'line1\nline2\nline3\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nSWAP 2-2\nREPLACED\n---\n`)
    const result = applyPatch(file, firstPatch(patches))
    expect(result).toEqual({ _tag: 'success', content: 'line1\nREPLACED\nline3\n' })
  })

  // 回归：最后一个操作省略 `---`（模型常见——以文件尾作块尾）时，尾部空行
  // 被收进 SWAP 内容：替换行后凭空多出一行空行。
  it('SWAP without trailing --- does not insert a phantom blank line', () => {
    const file = 'line1\nline2\nline3\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nSWAP 2-2\nREPLACED\n`)
    const result = applyPatch(file, firstPatch(patches))
    expect(result).toEqual({ _tag: 'success', content: 'line1\nREPLACED\nline3\n' })
  })

  it('INS.TAIL without trailing --- does not append a phantom blank line', () => {
    const file = 'mid\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nINS.TAIL\nTAIL\n`)
    const result = applyPatch(file, firstPatch(patches))
    expect(result).toEqual({ _tag: 'success', content: 'mid\nTAIL\n' })
  })

  // 内容里「合法结尾空行」仍须保留：`---` 前显式空行是替换内容的一部分。
  it('explicit blank line before --- remains part of SWAP content', () => {
    const file = 'a\nb\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nSWAP 1-1\nX\n\n---\n`)
    const result = applyPatch(file, firstPatch(patches))
    expect(result).toEqual({ _tag: 'success', content: 'X\n\nb\n' })
  })

  it('returns hash_mismatch when hash differs', () => {
    const file = 'line1\nline2\n'
    const patches = parsePatch('[f.ts#ffff]\nSWAP 1-1\nx\n---\n')
    const result = applyPatch(file, firstPatch(patches))
    expect(result._tag).toBe('hash_mismatch')
    if (result._tag === 'hash_mismatch') {
      expect(result.expected).toBe('ffff')
      expect(result.actual).toBe(computeHash(file))
    }
  })

  it('returns line_not_found when range exceeds file', () => {
    const file = 'only\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nSWAP 5-6\nx\n---\n`)
    const result = applyPatch(file, firstPatch(patches))
    expect(result._tag).toBe('line_not_found')
  })

  it('applies DEL', () => {
    const file = 'a\nb\nc\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nDEL 2\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({ _tag: 'success', content: 'a\nc\n' })
  })

  // 回归：SWAP 内容包含 [path#hash] 形行时，块被提前截断——内容行丢失且
  // 后续行被当作操作解析（edit 工具报 unknown operation，合法编辑失败）。
  it('SWAP applies header-like content lines verbatim', () => {
    const file = 'old line\nkeep\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nSWAP 1-1\n[a.md#1234]\nmore\n---\n`)
    const result = applyPatch(file, firstPatch(patches))
    expect(result).toEqual({ _tag: 'success', content: '[a.md#1234]\nmore\nkeep\n' })
  })

  // 回归：DEL 无 --- 时后续 INS.TAIL 被整体吞掉——删除生效、追加静默丢失，
  // 工具仍报 success（模型以为两个操作都完成）。
  it('DEL without --- still applies the following INS.TAIL', () => {
    const file = 'a\nb\nc\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nDEL 2\nINS.TAIL\nX\n`)
    const result = applyPatch(file, firstPatch(patches))
    expect(result).toEqual({ _tag: 'success', content: 'a\nc\nX\n' })
  })

  // 回归：SWAP 无 --- 时后续操作行被整段吸进替换内容，操作静默变成文本。
  it('SWAP without --- still applies the following operations', () => {
    const file = 'l1\nl2\nl3\nl4\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nSWAP 1-1\nA\nDEL 3\nINS.HEAD\nH\n`)
    const result = applyPatch(file, firstPatch(patches))
    expect(result).toEqual({ _tag: 'success', content: 'H\nA\nl2\nl4\n' })
  })

  // 回归：`--- ` 尾随空白不被识别为终止符——SWAP 把 `--- ` 与后续操作行
  // 整段吸进替换内容，原定 DEL 静默变成「写入两行文本」，工具报 success。
  it('applies ops separated by whitespace-padded ---', () => {
    const file = 'a\nb\nc\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nSWAP 1-1\nX\n --- \nDEL 3\n`)
    const result = applyPatch(file, firstPatch(patches))
    expect(result).toEqual({ _tag: 'success', content: 'X\nb\n' })
  })

  it('applies INS.PRE / INS.POST', () => {
    const file = 'a\nb\nc\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nINS.PRE 2\nPRE\n---\nINS.POST 2\nPOST\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: 'a\nPRE\nb\nPOST\nc\n',
    })
  })

  it('applies INS.HEAD / INS.TAIL', () => {
    const file = 'mid\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nINS.HEAD\nHEAD\n---\nINS.TAIL\nTAIL\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: 'HEAD\nmid\nTAIL\n',
    })
  })

  it('applies multiple ops using original line anchors (descending)', () => {
    // 两个 SWAP，行号都基于原文件；高行号先应用，低行号不受影响
    const file = 'l1\nl2\nl3\nl4\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nSWAP 1-1\nONE\n---\nSWAP 4-4\nFOUR\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: 'ONE\nl2\nl3\nFOUR\n',
    })
  })

  // 回归：CRLF 文件按 \n 拆分后行 token 残留 \r——SWAP 替换整行（含其 \r），
  // 替换行静默丢失 \r，与未触碰行混成 CRLF/LF 混合行尾。
  it('preserves CRLF line endings on SWAP', () => {
    const file = 'line1\r\nline2\r\nline3\r\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nSWAP 2-2\nREPLACED\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: 'line1\r\nREPLACED\r\nline3\r\n',
    })
  })

  // 回归：INS.PRE/POST 插入的行此前用 \n 连接——CRLF 文件中插入的行
  // 与两侧行尾不一致。
  it('uses CRLF for inserted lines in CRLF files', () => {
    const file = 'a\r\nb\r\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nINS.POST 1\nX\nY\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: 'a\r\nX\r\nY\r\nb\r\n',
    })
  })

  it('DEL on CRLF file keeps remaining line endings intact', () => {
    const file = 'a\r\nb\r\nc\r\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nDEL 2\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: 'a\r\nc\r\n',
    })
  })

  // 回归：内容行剥离 \r 只在文件为 CRLF 时生效——LF 文件 + CRLF 补丁内容
  //（模型粘贴 Windows 文本）时插入/替换行残留 \r，与其余行混成 CRLF/LF 混合行尾。
  it('normalizes CRLF patch content into LF files', () => {
    const file = 'a\nb\nc\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nSWAP 2-2\nX\r\nY\r\n---\nINS.TAIL\nZ\r\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: 'a\nX\nY\nc\nZ\n',
    })
  })

  // 回归：无 \n 结尾的孤立 \r 是文件内容而非行尾——LF 判定下不得剥离。
  it('keeps lone CR characters in LF files untouched', () => {
    const file = 'a\nb\r'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nSWAP 1-1\nX\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: 'X\nb\r',
    })
  })

  // 回归：同锚点操作按补丁顺序（稳定排序）应用——插入操作先于「消耗该锚点」的
  // SWAP/DEL 执行时，插入内容被替换/删除操作吞掉：顶部插入的一行被 SWAP 1-1
  // 当成第 1 行替换掉，而原第 1 行反而保留（两个操作都没有生效）。
  it('同锚点的 INS.HEAD 与 SWAP 1-1：先替换后插入（插入内容不被吞掉）', () => {
    const file = '1\n2\n3\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nINS.HEAD\nHEADER\n---\nSWAP 1-1\nONE\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: 'HEADER\nONE\n2\n3\n',
    })
  })

  it('同锚点的 INS.PRE 与 SWAP：插入行落在替换后的行之前', () => {
    const file = 'a\nb\nc\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nINS.PRE 2\nX\n---\nSWAP 2-2\nB\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: 'a\nX\nB\nc\n',
    })
  })

  it('同锚点的 INS.PRE 与 DEL：插入行保留、被删行确实消失', () => {
    const file = '1\n2\n3\n4\n5\n6\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nINS.PRE 3\nX\n---\nDEL 3-5\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: '1\n2\nX\n6\n',
    })
  })

  it('同锚点的 INS.POST 与下一行 SWAP：插入行落在被替换行之前', () => {
    const file = '1\n2\n3\n4\n5\n6\n'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nINS.POST 4\nX\n---\nSWAP 5-5\nFIVE\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: '1\n2\n3\n4\nX\nFIVE\n6\n',
    })
  })

  it('preserves missing trailing newline on CRLF files', () => {
    const file = 'a\r\nb\r\nc'
    const hash = computeHash(file)
    const patches = parsePatch(`[f.ts#${hash}]\nSWAP 2-2\nB\n---\n`)
    expect(applyPatch(file, firstPatch(patches))).toEqual({
      _tag: 'success',
      content: 'a\r\nB\r\nc',
    })
  })
})
