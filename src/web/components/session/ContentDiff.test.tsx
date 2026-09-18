import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ContentDiff } from '@/components/session/ContentDiff.js'

afterEach(() => cleanup())

// haze DiffViewer 的行以 data-slot="line" 标识，行类型由行内 data-slot="sign"
// 符号（'+ '/'- '）判定——这是渲染层对外的可观察契约。
const diffRows = () => screen.getByTestId('diff').querySelectorAll('[data-slot="line"]')
const bySign = (prefix: string) =>
  Array.from(diffRows()).filter((r) =>
    r.querySelector('[data-slot="sign"]')?.textContent?.startsWith(prefix),
  )

describe('ContentDiff', () => {
  it('渲染新增行（added）', () => {
    render(<ContentDiff oldText="a" newText={'a\nb'} />)
    const added = bySign('+')
    expect(added.length).toBe(1)
    expect(added[0]).toHaveTextContent('b')
  })

  it('渲染删除行（removed）', () => {
    render(<ContentDiff oldText={'a\nb'} newText="a" />)
    const removed = bySign('-')
    expect(removed.length).toBe(1)
    expect(removed[0]).toHaveTextContent('b')
  })

  it('渲染未变行（unchanged）', () => {
    render(<ContentDiff oldText={'a\nb'} newText={'a\nb'} />)
    const unchanged = Array.from(diffRows()).filter(
      (r) => r.querySelector('[data-slot="sign"]') === null,
    )
    expect(unchanged.length).toBe(2)
  })
})
