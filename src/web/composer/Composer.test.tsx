// 大段粘贴（≥8000 字符 或 ≥120 行）走「先确认再插入」路径：handlePaste 已
// preventDefault 吞掉原生插入，若不渲染确认条并让用户确认，整段文本会静默丢失。
// 这里锁住三个行为：出现确认条且未插入、确认后插入规范化文本、取消后丢弃。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@/composer/Composer.js'
import type { ImagePart, Prompt } from '@/composer/types.js'
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

// 首条消息失败伴随导航（清空会话 → 回草稿页），原输入框组件已卸载，必须由
// 外部把内容灌进新实例。此前按 restoreDraft 的**对象身份**去重，而父组件很容易
// 在 JSX 里每次渲染新建 `{prompt, images}` 字面量——去重一路落空，用户改到一半
// 的文字被上一次失败的载荷反复盖回去。改为按内容去重。
describe('Composer 跨实例还原草稿', () => {
  const failedDraft: { prompt: Prompt; images: ImagePart[] } = {
    prompt: [{ type: 'text', content: '失败的那条', start: 0, end: 5 }],
    images: [],
  }

  /** 以「每次渲染新建字面量」的方式传 restoreDraft——调用方的真实写法。 */
  function Harness() {
    return (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <FileSelectionContext.Provider
          value={{ selectedFile: null, openFile: () => {}, closeFile: () => {} }}
        >
          <Composer
            onSend={vi.fn()}
            isStreaming={false}
            hasHistory={false}
            agents={[]}
            restoreDraft={{ ...failedDraft }}
          />
        </FileSelectionContext.Provider>
      </QueryClientProvider>
    )
  }

  it('载荷内容不变时只还原一次，父组件后续重渲染不再覆盖用户编辑', () => {
    const view = render(<Harness />)
    const editor = screen.getByTestId('composer-editor')
    fireEvent.input(editor, { target: { textContent: '失败的那条' } })
    expect(editor.textContent).toContain('失败的那条')

    // 用户在此基础上继续编辑
    fireEvent.input(editor, { target: { textContent: '失败的那条 我改的' } })

    // 父组件因任何原因重渲染（model/agent 切换、agents refetch、打开文件预览…），
    // restoreDraft 拿到的是一个全新的对象字面量
    view.rerender(<Harness />)

    expect(editor.textContent).toContain('我改的')
  })
})
