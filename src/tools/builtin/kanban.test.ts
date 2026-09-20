import { describe, expect, it } from 'vitest'
import type { KanbanPriority } from '../../shared/types/kanban.js'
import { formatBoardSummary } from './kanban.js'

/** 孤立代理码元：高代理后不跟低代理，或低代理前不是高代理。 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function board(description: string | null) {
  return {
    columns: [{ id: 'todo', name: 'todo' }],
    cards: [
      {
        id: 'abc12345-0000-4000-8000-000000000000',
        title: 'Demo card',
        columnId: 'todo',
        priority: 'medium' as KanbanPriority,
        description,
      },
    ],
  }
}

describe('formatBoardSummary', () => {
  it('renders card preview for short descriptions', () => {
    const out = formatBoardSummary(board('short desc'))
    expect(out).toContain('short desc')
    expect(out).toContain('[abc12345]')
  })

  it('truncates long descriptions with ellipsis', () => {
    const out = formatBoardSummary(board('x'.repeat(200)))
    expect(out).toContain(`${'x'.repeat(77)}…`)
  })

  // 回归：slice(0, 77) 按 UTF-16 码元硬切——截断点落在 emoji 代理对中间时
  // 输出带孤立代理码元，经 JSON/UTF-8 往返损坏为 U+FFFD。
  it('never splits surrogate pairs at the preview boundary', () => {
    // 76 x + 😀(2 码元) + zzz：截断点 77 恰好拆开代理对
    const out = formatBoardSummary(board(`${'x'.repeat(76)}😀zzz`))
    expect(LONE_SURROGATE_RE.test(out)).toBe(false)
    expect(out).toContain(`${'x'.repeat(76)}…`)
  })
})
