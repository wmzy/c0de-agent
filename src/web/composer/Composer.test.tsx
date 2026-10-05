// 大段粘贴（≥8000 字符 或 ≥120 行）走「先确认再插入」路径：handlePaste 已
// preventDefault 吞掉原生插入，若不渲染确认条并让用户确认，整段文本会静默丢失。
// 这里锁住三个行为：出现确认条且未插入、确认后插入规范化文本、取消后丢弃。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@/composer/Composer.js'
import { FileSelectionContext } from '@/contexts/FileSelectionContext.js'

vi.mock('@/services/commands.js', () => ({
  commandsAPI: { list: vi.fn().mockResolvedValue({ commands: [] }) },
}))

vi.mock('@/services/workflows.js', () => ({
  workflowsAPI: { list: vi.fn().mockResolvedValue({ workflows: [] }) },
}))

const execCommand = vi.fn(() => true)

beforeEach(() => {
  Object.defineProperty(document, 'execCommand', {
    value: execCommand,
    configurable: true,
    writable: true,
  })
  execCommand.mockClear()
})

afterEach(() => cleanup())

function renderComposer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <FileSelectionContext.Provider
        value={{ selectedFile: null, openFile: () => {}, closeFile: () => {} }}
      >
        <Composer onSend={vi.fn()} isStreaming={false} hasHistory={false} agents={[]} />
      </FileSelectionContext.Provider>
    </QueryClientProvider>,
  )
  return screen.getByTestId('composer-editor')
}

/** happy-dom 的 ClipboardEvent 不支持 init.clipboardData，直接构造原生事件注入。 */
function pasteText(el: HTMLElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { items: [], getData: () => text },
  })
  fireEvent(el, event)
}

const LARGE = `${'x'.repeat(9000)}\r\nsecond`

describe('Composer 大段粘贴', () => {
  it('大段粘贴先要求确认，不直接插入', () => {
    const editor = renderComposer()
    pasteText(editor, LARGE)
    expect(execCommand).not.toHaveBeenCalled()
    const bar = screen.getByTestId('paste-confirm')
    expect(bar.textContent).toContain(`${LARGE.length} 字符`)
    expect(bar.textContent).toContain('2 行')
  })

  it('确认后插入规范化文本（CRLF → LF）并把焦点交还编辑器', () => {
    const editor = renderComposer()
    pasteText(editor, LARGE)
    fireEvent.click(screen.getByTestId('paste-confirm-insert'))
    expect(execCommand).toHaveBeenCalledWith('insertText', false, `${'x'.repeat(9000)}\nsecond`)
    expect(screen.queryByTestId('paste-confirm')).toBeNull()
    expect(document.activeElement).toBe(editor)
  })

  it('取消后丢弃该段文本且焦点交还编辑器', () => {
    const editor = renderComposer()
    pasteText(editor, LARGE)
    fireEvent.click(screen.getByTestId('paste-confirm-cancel'))
    expect(execCommand).not.toHaveBeenCalled()
    expect(screen.queryByTestId('paste-confirm')).toBeNull()
    expect(document.activeElement).toBe(editor)
  })

  it('短文本粘贴仍是即时插入，不弹确认条', () => {
    const editor = renderComposer()
    pasteText(editor, 'l1\nl2')
    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'l1\nl2')
    expect(screen.queryByTestId('paste-confirm')).toBeNull()
  })
})
