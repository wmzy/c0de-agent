import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ContentDiff } from './ContentDiff.js'

afterEach(() => cleanup())

describe('ContentDiff', () => {
  it('渲染新增行（added）', () => {
    render(<ContentDiff oldText="a" newText={'a\nb'} />)
    const rows = screen.getByTestId('diff').querySelectorAll('[data-diff]')
    const added = Array.from(rows).filter((r) => r.getAttribute('data-diff') === 'added')
    expect(added.length).toBe(1)
    expect(added[0]).toHaveTextContent('b')
  })

  it('渲染删除行（removed）', () => {
    render(<ContentDiff oldText={'a\nb'} newText="a" />)
    const rows = screen.getByTestId('diff').querySelectorAll('[data-diff]')
    const removed = Array.from(rows).filter((r) => r.getAttribute('data-diff') === 'removed')
    expect(removed.length).toBe(1)
    expect(removed[0]).toHaveTextContent('b')
  })

  it('渲染未变行（unchanged）', () => {
    render(<ContentDiff oldText={'a\nb'} newText={'a\nb'} />)
    const rows = screen.getByTestId('diff').querySelectorAll('[data-diff]')
    const unchanged = Array.from(rows).filter((r) => r.getAttribute('data-diff') === 'unchanged')
    expect(unchanged.length).toBe(2)
  })
})