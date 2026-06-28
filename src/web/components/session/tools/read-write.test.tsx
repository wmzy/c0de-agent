import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ReadToolView } from './ReadToolView.js'
import { WriteToolView } from './WriteToolView.js'

afterEach(() => cleanup())

describe('ReadToolView', () => {
  it('渲染文件名', () => {
    render(<ReadToolView input={{ path: 'src/a.ts' }} status="completed" />)
    expect(screen.getByTestId('tool-title')).toHaveTextContent('read')
    expect(screen.getByTestId('file-name')).toHaveTextContent('src/a.ts')
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
})

describe('WriteToolView', () => {
  it('渲染文件名与写入提示', () => {
    render(<WriteToolView input={{ path: 'b.ts', content: 'x' }} status="completed" />)
    expect(screen.getByTestId('file-name')).toHaveTextContent('b.ts')
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
