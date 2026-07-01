import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSelectionContext } from '../contexts/FileSelectionContext.js'
import { FilePathLink } from './FilePathLink.js'

afterEach(cleanup)

// 用假 Provider 包裹，捕获 openFile 调用
function withSelection(ui: React.ReactNode, openFile = vi.fn()) {
  render(
    <FileSelectionContext.Provider
      value={{ selectedFile: null, openFile, closeFile: () => {} }}
    >
      {ui}
    </FileSelectionContext.Provider>,
  )
  return openFile
}

describe('FilePathLink', () => {
  it('渲染路径文本', () => {
    withSelection(<FilePathLink path="src/a.ts" />)
    expect(screen.getByText('src/a.ts')).toBeTruthy()
  })

  it('点击调用 openFile', () => {
    const openFile = withSelection(<FilePathLink path="src/a.ts" />)
    fireEvent.click(screen.getByText('src/a.ts'))
    expect(openFile).toHaveBeenCalledWith('src/a.ts')
  })

  it('有 title 属性提示', () => {
    withSelection(<FilePathLink path="src/a.ts" />)
    expect(screen.getByText('src/a.ts').getAttribute('title')).toContain('src/a.ts')
  })
})
