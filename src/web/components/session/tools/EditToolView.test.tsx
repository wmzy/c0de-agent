import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EditToolView } from '@/components/session/tools/EditToolView.js'

afterEach(cleanup)

describe('EditToolView', () => {
  it('渲染 diff', () => {
    render(
      <EditToolView input={{ path: 'a.ts', oldText: 'old', newText: 'new' }} status="completed" />,
    )
    expect(screen.getByTestId('diff')).toBeInTheDocument()
    // haze DiffViewer：行以 data-slot="line" 标识，类型由行内符号（+/-）判定。
    const rows = screen.getByTestId('diff').querySelectorAll('[data-slot="line"]')
    const removed = Array.from(rows).filter((r) =>
      r.querySelector('[data-slot="sign"]')?.textContent?.startsWith('-'),
    )
    const added = Array.from(rows).filter((r) =>
      r.querySelector('[data-slot="sign"]')?.textContent?.startsWith('+'),
    )
    expect(removed.length).toBe(1)
    expect(added.length).toBe(1)
  })

  it('error 状态显示错误', () => {
    render(
      <EditToolView
        input={{ path: 'a.ts', oldText: 'o', newText: 'n' }}
        status="error"
        output={{ _tag: 'error', error: 'not found' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('not found')
  })
})
