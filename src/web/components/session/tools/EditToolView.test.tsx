import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EditToolView } from './EditToolView.js'

afterEach(cleanup)

describe('EditToolView', () => {
  it('渲染 diff', () => {
    render(
      <EditToolView input={{ path: 'a.ts', oldText: 'old', newText: 'new' }} status="completed" />,
    )
    expect(screen.getByTestId('diff')).toBeInTheDocument()
    const removed = screen.getByTestId('diff').querySelectorAll('[data-diff="removed"]')
    const added = screen.getByTestId('diff').querySelectorAll('[data-diff="added"]')
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
