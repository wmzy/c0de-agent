import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSelectionContext } from '../../../contexts/FileSelectionContext.js'
import { EditToolView } from './EditToolView.js'

afterEach(cleanup)

// FilePathLink 依赖 FileSelectionContext，测试需包裹假 Provider
function withProvider(ui: React.ReactNode, openFile = vi.fn()) {
  render(
    <FileSelectionContext.Provider
      value={{ selectedFile: null, openFile, closeFile: () => {} }}
    >
      {ui}
    </FileSelectionContext.Provider>,
  )
  return openFile
}

describe('EditToolView', () => {
  it('渲染文件名与 diff', () => {
    withProvider(
      <EditToolView input={{ path: 'a.ts', oldText: 'old', newText: 'new' }} status="completed" />,
    )
    expect(screen.getByTestId('file-name')).toHaveTextContent('a.ts')
    expect(screen.getByTestId('diff')).toBeInTheDocument()
    const removed = screen.getByTestId('diff').querySelectorAll('[data-diff="removed"]')
    const added = screen.getByTestId('diff').querySelectorAll('[data-diff="added"]')
    expect(removed.length).toBe(1)
    expect(added.length).toBe(1)
  })

  it('error 状态显示错误', () => {
    withProvider(
      <EditToolView
        input={{ path: 'a.ts', oldText: 'o', newText: 'n' }}
        status="error"
        output={{ _tag: 'error', error: 'not found' }}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('not found')
  })

  it('路径为可点击 FilePathLink', () => {
    const openFile = withProvider(
      <EditToolView
        input={{ path: 'src/a.ts', oldText: 'x', newText: 'y' }}
        status="completed"
      />,
    )
    const link = screen.getByTestId('filepath-link')
    link.click()
    expect(openFile).toHaveBeenCalledWith('src/a.ts')
  })
})
