import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ReadToolView } from './ReadToolView.js'
import { WriteToolView } from './WriteToolView.js'

afterEach(cleanup)

describe('ReadToolView', () => {
  it('有内容时渲染代码块', () => {
    const { container } = render(
      <ReadToolView
        input={{ path: 'src/a.ts' }}
        output={{ _tag: 'success', output: 'file content' }}
        status="completed"
      />,
    )
    // FileCodeBlock 渲染出代码区（pre 或 CodeBlock 高亮容器）
    expect(container.querySelector('pre, [class]')).not.toBeNull()
  })

  it('error 状态显示错误信息', () => {
    render(
      <ReadToolView
        input={{ path: 'a.ts' }}
        status="error"
        output={{ _tag: 'error', error: 'no file' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('no file')
  })

  it('无内容时不渲染代码块', () => {
    const { container } = render(<ReadToolView input={{ path: 'a.ts' }} status="running" />)
    expect(container.querySelector('pre')).toBeNull()
  })
})

describe('WriteToolView', () => {
  it('渲染写入内容代码块', () => {
    const { container } = render(
      <WriteToolView input={{ path: 'b.ts', content: 'written' }} status="completed" />,
    )
    expect(container.querySelector('pre, [class]')).not.toBeNull()
  })

  it('error 状态显示错误信息', () => {
    render(
      <WriteToolView
        input={{ path: 'b.ts', content: 'x' }}
        status="error"
        output={{ _tag: 'error', error: 'permission denied' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('permission denied')
  })
})
