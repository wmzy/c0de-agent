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

  it('parses multiple patch blocks', () => {
    const patches = parsePatch('[a.ts#1111]\nDEL 1\n---\n[b.ts#2222]\nDEL 2\n---\n')
    expect(patches).toHaveLength(2)
    expect(patches[0]?.path).toBe('a.ts')
    expect(patches[1]?.path).toBe('b.ts')
  })

  it('throws on malformed header', () => {
    expect(() => parsePatch('not a header\nDEL 1\n---\n')).toThrow()
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
})
