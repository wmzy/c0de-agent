import { describe, expect, it } from 'vitest'
import {
  canNavigateHistoryAtCursor,
  navigatePromptHistory,
  prependHistoryEntry,
} from './history.js'

describe('canNavigateHistoryAtCursor', () => {
  it('↑ 仅在光标处于第一行时触发', () => {
    // 单行文本，光标在开头 → 第一行
    expect(canNavigateHistoryAtCursor('up', 'abc', 0)).toBe(true)
    // 单行文本，光标在末尾 → 仍是第一行（无换行）
    expect(canNavigateHistoryAtCursor('up', 'abc', 3)).toBe(true)
    // 多行文本，光标不在第一行 → 不触发
    expect(canNavigateHistoryAtCursor('up', 'a\nb\nc', 4)).toBe(false)
    // 多行文本，光标在第一行内 → 触发
    expect(canNavigateHistoryAtCursor('up', 'a\nb', 1)).toBe(true)
  })

  it('↓ 仅在历史回溯中且光标处于最后一行时触发', () => {
    // 多行，已在历史中，光标在末尾 → 最后一行 → 触发
    expect(canNavigateHistoryAtCursor('down', 'a\nb', 3, true)).toBe(true)
    // 多行，已在历史中，光标不在最后一行 → 不触发
    expect(canNavigateHistoryAtCursor('down', 'a\nb\nc', 2, true)).toBe(false)
    // 不在历史回溯中时 ↓ 不触发（即便在最后一行）
    expect(canNavigateHistoryAtCursor('down', 'abc', 3, false)).toBe(false)
    // 未传 inHistory 时默认不触发
    expect(canNavigateHistoryAtCursor('down', 'a\nb', 3)).toBe(false)
  })
})

describe('prependHistoryEntry', () => {
  it('新条目插到最前', () => {
    const result = prependHistoryEntry(['old'], 'new')
    expect(result[0]).toBe('new')
    expect(result).toHaveLength(2)
  })

  it('与最新条目重复时不重复插入', () => {
    const result = prependHistoryEntry(['same'], 'same')
    expect(result).toEqual(['same'])
  })

  it('超过上限截断', () => {
    const entries = Array.from({ length: 100 }, (_, i) => `old${i}`)
    const result = prependHistoryEntry(entries, 'new', 100)
    expect(result).toHaveLength(100)
    expect(result[0]).toBe('new')
    expect(result[100]).toBeUndefined()
  })

  it('空文本不加入历史', () => {
    expect(prependHistoryEntry(['a'], '  ')).toEqual(['a'])
  })
})

describe('navigatePromptHistory', () => {
  const entries = ['first', 'second', 'third']

  it('↑ 从空闲态进入历史，返回最新条目', () => {
    const r = navigatePromptHistory({ entries, currentIndex: -1, direction: 'up', draft: '' })
    expect(r).toMatchObject({ entry: 'third', index: 2 })
  })

  it('↑ 持续向上遍历', () => {
    const r1 = navigatePromptHistory({ entries, currentIndex: -1, direction: 'up', draft: '' })
    expect(r1).toMatchObject({ entry: 'third', index: 2 })
    const prevIndex = r1 && 'entry' in r1 ? r1.index : -1
    const prevEntry = r1 && 'entry' in r1 ? r1.entry : ''
    const r = navigatePromptHistory({
      entries,
      currentIndex: prevIndex,
      direction: 'up',
      draft: prevEntry,
    })
    expect(r).toMatchObject({ entry: 'second', index: 1 })
  })

  it('↑ 到顶不再上移', () => {
    const r = navigatePromptHistory({ entries, currentIndex: 0, direction: 'up', draft: 'first' })
    expect(r).toMatchObject({ entry: 'first', index: 0 })
  })

  it('↓ 到底退出历史回到草稿', () => {
    const r = navigatePromptHistory({
      entries,
      currentIndex: 2,
      direction: 'down',
      draft: 'mydraft',
    })
    expect(r).toMatchObject({ reset: true })
  })
})
