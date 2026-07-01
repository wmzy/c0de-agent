import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSelectionContext } from '../../../contexts/FileSelectionContext.js'
import { ReadToolView } from './ReadToolView.js'
import { WriteToolView } from './WriteToolView.js'

afterEach(cleanup)

// FilePathLink 依赖 FileSelectionContext，测试需包裹假 Provider
function withProvider(ui: React.ReactNode, openFile = vi.fn()) {
  render(
    <FileSelectionContext.Provider value={{ selectedFile: null, openFile, closeFile: () => {} }}>
      {ui}
    </FileSelectionContext.Provider>,
  )
  return openFile
}

describe('ReadToolView', () => {
  it('渲染文件名', () => {
    withProvider(<ReadToolView input={{ path: 'src/a.ts' }} status="completed" />)
    expect(screen.getByTestId('tool-title')).toHaveTextContent('read')
    expect(screen.getByTestId('file-name')).toHaveTextContent('src/a.ts')
  })

  it('error 状态显示错误信息', () => {
    withProvider(
      <ReadToolView
        input={{ path: 'a.ts' }}
        status="error"
        output={{ _tag: 'error', error: 'no file' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('no file')
  })

  it('路径为可点击 FilePathLink', () => {
    const openFile = withProvider(<ReadToolView input={{ path: 'src/a.ts' }} status="completed" />)
    const link = screen.getByTestId('filepath-link')
    expect(link.textContent).toBe('src/a.ts')
    link.click()
    expect(openFile).toHaveBeenCalledWith('src/a.ts')
  })
})

describe('WriteToolView', () => {
  it('渲染文件名与写入提示', () => {
    withProvider(<WriteToolView input={{ path: 'b.ts', content: 'x' }} status="completed" />)
    expect(screen.getByTestId('file-name')).toHaveTextContent('b.ts')
  })

  it('error 状态显示错误信息', () => {
    withProvider(
      <WriteToolView
        input={{ path: 'b.ts', content: 'x' }}
        status="error"
        output={{ _tag: 'error', error: 'permission denied' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('permission denied')
  })

  it('路径为可点击 FilePathLink', () => {
    const openFile = withProvider(
      <WriteToolView input={{ path: 'b.ts', content: 'x' }} status="completed" />,
    )
    const link = screen.getByTestId('filepath-link')
    link.click()
    expect(openFile).toHaveBeenCalledWith('b.ts')
  })
})
