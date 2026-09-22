// Prompt 结构操作：@token 定位与平铺文本范围替换。
// 回归：popover 插入（@文件/@agent）与外部引用追加此前把 prompt 从
// promptToText 平铺文本重建——既有 file/snippet/terminal pill 被降级为
// 纯文本（发送时 files 附件丢失、snippet/terminal 内容不再注入消息）。

import { describe, expect, it } from 'vitest'
import {
  atTokenRange,
  clonePromptParts,
  type Prompt,
  replacePromptRange,
} from '@/composer/types.js'

function filePill(path: string): Prompt {
  return [{ type: 'file', path, content: path, start: 0, end: path.length }]
}

describe('atTokenRange', () => {
  it('定位光标前的 @token 范围（含查询串）', () => {
    expect(atTokenRange('hello @qu', 8)).toEqual({ start: 6, end: 8 })
    expect(atTokenRange('@', 1)).toEqual({ start: 0, end: 1 })
    expect(atTokenRange('hello @', 7)).toEqual({ start: 6, end: 7 })
  })

  it('仅匹配紧贴光标的 token，光标后的 @ 不参与', () => {
    expect(atTokenRange('@a @b', 2)).toEqual({ start: 0, end: 2 })
  })

  it('光标前无 @token 返回 null', () => {
    expect(atTokenRange('hello world', 11)).toBeNull()
    expect(atTokenRange('a@ b', 4)).toBeNull()
  })
})

describe('replacePromptRange', () => {
  it('替换 @token 时保留前方 file pill（此前被降级为文本）', () => {
    const prompt: Prompt = [
      { type: 'text', content: 'hello ', start: 0, end: 6 },
      { type: 'file', path: 'a.ts', content: 'a.ts', start: 6, end: 10 },
      { type: 'text', content: ' @qu', start: 10, end: 14 },
    ]
    const next = replacePromptRange(prompt, 11, 14, filePill('b.ts'))
    expect(next.filter((p) => p.type === 'file').map((p) => (p as { path: string }).path)).toEqual([
      'a.ts',
      'b.ts',
    ])
    // 文本部分不再包含 pill 的平铺内容
    expect(
      next.filter((p) => p.type === 'text').map((p) => (p as { content: string }).content),
    ).toEqual(['hello ', ' '])
  })

  it('范围落在单个文本 part 内部时正确切分', () => {
    const prompt: Prompt = [{ type: 'text', content: 'ab cd', start: 0, end: 5 }]
    const next = replacePromptRange(prompt, 3, 5, [
      { type: 'text', content: 'X', start: 0, end: 1 },
    ])
    expect(next).toEqual([
      { type: 'text', content: 'ab ', start: 0, end: 3 },
      { type: 'text', content: 'X', start: 0, end: 1 },
    ])
  })

  it('空范围插入不吞并相邻内容', () => {
    const prompt: Prompt = [
      { type: 'file', path: 'a.ts', content: 'a.ts', start: 0, end: 4 },
      { type: 'text', content: '', start: 4, end: 4 },
    ]
    const next = replacePromptRange(prompt, 4, 4, [
      { type: 'text', content: '@x ', start: 0, end: 3 },
    ])
    expect(next.map((p) => p.type)).toEqual(['file', 'text'])
    expect((next[1] as { content: string }).content).toBe('@x ')
  })

  it('替换范围跨过 pill 时保守保留 pill（不拆分）', () => {
    const prompt: Prompt = [
      { type: 'text', content: 'x', start: 0, end: 1 },
      { type: 'file', path: 'a.ts', content: 'a.ts', start: 1, end: 5 },
      { type: 'text', content: 'y', start: 5, end: 6 },
    ]
    const next = replacePromptRange(prompt, 0, 6, [
      { type: 'text', content: 'z', start: 0, end: 1 },
    ])
    // 文本首尾被替换，pill 保留
    expect(next.map((p) => p.type)).toEqual(['text', 'file'])
    expect((next[0] as { content: string }).content).toBe('z')
  })
})

describe('clonePromptParts', () => {
  it('完整保留 text/file/snippet/terminal 各类型（此前 append* 逐类挑选会丢类型）', () => {
    const prompt: Prompt = [
      { type: 'text', content: 't', start: 0, end: 1 },
      { type: 'file', path: 'f', content: 'f', start: 1, end: 2 },
      {
        type: 'snippet',
        path: 's',
        lineStart: 1,
        lineEnd: 2,
        label: 's',
        snippet: 'code',
        start: 2,
        end: 3,
      },
      { type: 'terminal', label: 'term', content: 'out', start: 3, end: 7 },
    ]
    expect(clonePromptParts(prompt).map((p) => p.type)).toEqual([
      'text',
      'file',
      'snippet',
      'terminal',
    ])
    // 深拷贝：改克隆不影响原 prompt
    const clone = clonePromptParts(prompt)
    ;(clone[0] as { content: string }).content = 'mutated'
    expect((prompt[0] as { content: string }).content).toBe('t')
  })
})
