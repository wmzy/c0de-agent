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

  // 复现：视图重建 effect 读的是「已见 initial」镜像 ref（lastInitialRef），而该
  // ref 由声明在**其后**的同步 effect 更新——同一 commit 内换文件时它仍是上一个
  // 文件的内容：编辑器载入旧文件文档、脏标记被清（关闭确认失效），同步 effect 又
  // 把新文件内容判成「编辑期间的外部变更」弹出误报横幅；此时保存会把旧文件内容
  // 写进新文件。既有「切换文件」用例未覆盖：它 rerender 的树结构变化（少了
  // ThemeToggle）导致 CodeEditor 被重挂载，掩盖了本缺陷。
  it('带未保存编辑切换文件（同一实例）→ 载入新文件内容且不误报外部变更', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const tree = (path: string, initial: string) => (
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <CodeEditor path={path} initial={initial} />
        </ThemeProvider>
      </QueryClientProvider>
    )
    const { container, rerender } = render(tree('a.ts', 'AAA'))
    await waitFor(() => expect(liveView(container)?.state.doc.toString()).toBe('AAA'))
    liveView(container)?.dispatch({ changes: { from: 0, insert: 'edited-' } })
    await waitFor(() => expect(liveView(container)?.state.doc.toString()).toBe('edited-AAA'))

    rerender(tree('b.ts', 'BBB'))

    await waitFor(() => expect(liveView(container)?.state.doc.toString()).toBe('BBB'))
    expect(container.querySelector('[data-testid="external-change-banner"]')).toBeNull()
    expect(container.textContent).not.toContain('保存*')
  })

  // 复现：跳转定位用 `host.querySelectorAll('.cm-line')[start - 1]`——CodeMirror
  // 只渲染视口内的行（其余行由 .cm-gap 占位），DOM 下标 ≠ 文档行号：目标行在首屏
  // 之外时取不到元素，跳转静默不发生（点开「📄 file.ts:1200」引用后编辑器停在文首）。
  it('跳转到首屏之外的行时滚动到该行（虚拟化下该行不在初始 DOM 中）', async () => {
    const doc = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <CodeEditor path="big.ts" initial={doc} highlightRange={{ start: 1200, end: 1200 }} />
        </ThemeProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(liveView(container)).toBeTruthy())
    const host = container.querySelector('.cm-editor')?.parentElement as HTMLElement
    // 目标行 1200 远离文首：滚动位置必须落在该行附近（按行高估算 ≥ 数 px/行），
    // 而非停在 scrollTop=0（未滚动）。
    await waitFor(() => expect(host.scrollTop).toBeGreaterThan(1000))
  })

  it('跳转到文首附近的行时不产生大幅滚动', async () => {
    const doc = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <CodeEditor path="big.ts" initial={doc} highlightRange={{ start: 2, end: 2 }} />
        </ThemeProvider>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(liveView(container)).toBeTruthy())
    const host = container.querySelector('.cm-editor')?.parentElement as HTMLElement
    expect(host.scrollTop).toBeLessThan(1000)
  })
})
