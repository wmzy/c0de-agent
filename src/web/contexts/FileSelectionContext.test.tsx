import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSelectionContext, useFileSelection } from './FileSelectionContext.js'

afterEach(cleanup)

// 消费 hook 的测试组件
function Consumer() {
  const { selectedFile, openFile, closeFile } = useFileSelection()
  return (
    <div>
      <span data-testid="selected">{selectedFile ?? 'null'}</span>
      <button type="button" onClick={() => openFile('src/a.ts')} data-testid="open">
        open
      </button>
      <button type="button" onClick={closeFile} data-testid="close">
        close
      </button>
    </div>
  )
}

describe('FileSelectionContext', () => {
  it('无 Provider 时 useFileSelection 抛错', () => {
    // 抑制 console.error（React Provider 缺失会打印）
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Consumer />)).toThrow(
      'useFileSelection must be used within FileSelectionContext',
    )
    spy.mockRestore()
  })

  it('Provider 提供 openFile/closeFile/selectedFile', () => {
    render(
      <FileSelectionContext.Provider
        value={{
          selectedFile: null,
          openFile: () => {},
          closeFile: () => {},
        }}
      >
        <Consumer />
      </FileSelectionContext.Provider>,
    )
    expect(screen.getByTestId('selected').textContent).toBe('null')
  })

  it('openFile 更新 selectedFile（通过 Provider 内 state 驱动）', () => {
    function Wrapper() {
      const [f, setF] = useState<string | null>(null)
      return (
        <FileSelectionContext.Provider
          value={{ selectedFile: f, openFile: setF, closeFile: () => setF(null) }}
        >
          <Consumer />
        </FileSelectionContext.Provider>
      )
    }
    render(<Wrapper />)
    expect(screen.getByTestId('selected').textContent).toBe('null')
    fireEvent.click(screen.getByTestId('open'))
    expect(screen.getByTestId('selected').textContent).toBe('src/a.ts')
    fireEvent.click(screen.getByTestId('close'))
    expect(screen.getByTestId('selected').textContent).toBe('null')
  })
})
