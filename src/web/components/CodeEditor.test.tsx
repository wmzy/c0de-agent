import { EditorView } from '@codemirror/view'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeEditor } from '@/components/CodeEditor.js'
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext.js'

/** 主题切换按钮：真实用户在设置页切换明/暗，CodeEditor 的 resolved 随之变化。 */
function ThemeToggle() {
  const { setMode, resolved } = useTheme()
  return (
    <button
      type="button"
      data-testid="theme-toggle"
      onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
    >
      切换主题
    </button>
  )
}

function renderEditor(props: { path: string; initial: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <ThemeToggle />
        <CodeEditor {...props} />
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

/** 取当前编辑器视图（CodeMirror 把 view 挂在 contentDOM 上）。 */
function liveView(container: HTMLElement): EditorView | null {
  const dom = container.querySelector('.cm-content')
  return dom ? EditorView.findFromDOM(dom as HTMLElement) : null
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CodeEditor 未保存编辑保持', () => {
  // 复现：视图重建 effect 依赖 [path, resolved]，重建时以 baseRef（磁盘基线）
  // 作为初始 doc 并 setDirty(false)——切换明/暗主题即触发，用户未保存的编辑被
  // 静默丢弃，且脏标记被清除（关闭预览的丢弃确认随之失效）。
  it('切换主题保留未保存编辑与脏标记', async () => {
    const { container } = renderEditor({ path: 'a.ts', initial: 'disk-content' })
    await waitFor(() => expect(liveView(container)).toBeTruthy())

    const view = liveView(container)
    view?.dispatch({ changes: { from: 0, insert: 'USER-EDIT-' } })
    await waitFor(() =>
      expect(liveView(container)?.state.doc.toString()).toBe('USER-EDIT-disk-content'),
    )

    container.querySelector<HTMLElement>('[data-testid="theme-toggle"]')?.click()

    await waitFor(() => expect(document.documentElement.className).not.toBe(''))
    expect(liveView(container)?.state.doc.toString()).toBe('USER-EDIT-disk-content')
    // 脏标记未被清除：保存按钮仍显示未保存态
    expect(container.textContent).toContain('保存*')
  })

  it('切换文件（path 变化）仍以新文件内容重置编辑器与脏标记', async () => {
    const { container, rerender } = renderEditor({ path: 'a.ts', initial: 'AAA' })
    await waitFor(() => expect(liveView(container)?.state.doc.toString()).toBe('AAA'))
    liveView(container)?.dispatch({ changes: { from: 0, insert: 'edited-' } })
    await waitFor(() => expect(liveView(container)?.state.doc.toString()).toBe('edited-AAA'))

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rerender(
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <CodeEditor path="b.ts" initial="BBB" />
        </ThemeProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => expect(liveView(container)?.state.doc.toString()).toBe('BBB'))
    expect(container.textContent).not.toContain('保存*')
  })
})
