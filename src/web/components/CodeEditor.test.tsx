import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeEditor } from '@/components/CodeEditor.js'
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext.js'
import { fileAPI } from '@/services/file.js'

// mock 文件服务：保存链路（冲突检查的 read 与 write）在此拦截；
// 错误对象按 services/api.ts 的 ApiErrorImpl 契约构造（Error + status/code 自有属性）。
vi.mock('@/services/file.js', () => ({
  fileAPI: {
    read: vi.fn(),
    write: vi.fn(),
  },
}))

/** 构造 fileAPI 抛出的 APIError 形态（message 可枚举 + status/code 自有属性）。 */
function apiError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code })
}

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

  // 复现：主题切换走 new EditorView + destroy()，文档与脏标记靠 liveDoc/keepDirty
  // 接力保住了，撤销历史与选区没有——切主题后 Ctrl+Z 是空操作，光标跳回文首，
  // 紧接着敲的字插到文件开头。用户只是切了个配色，编辑现场就没了。
  it('切换主题后撤销历史与光标位置仍在', async () => {
    const { container } = renderEditor({ path: 'a.ts', initial: 'disk-content' })
    await waitFor(() => expect(liveView(container)).toBeTruthy())

    const view = liveView(container)
    view?.dispatch({ changes: { from: 0, insert: 'EDIT-' } })
    await waitFor(() => expect(liveView(container)?.state.doc.toString()).toBe('EDIT-disk-content'))
    const end = view?.state.doc.length ?? 0
    view?.dispatch({ selection: { anchor: end } })
    expect(view?.state.selection.main.head).toBe(end)

    container.querySelector<HTMLElement>('[data-testid="theme-toggle"]')?.click()
    await waitFor(() => expect(document.documentElement.className).not.toBe(''))

    // 选区/光标未被弹回文首
    expect(liveView(container)?.state.selection.main.head).toBe(end)
    // 撤销仍能回退这次编辑（重建视图后 undo 是空操作）
    undo(liveView(container) as EditorView)
    await waitFor(() => expect(liveView(container)?.state.doc.toString()).toBe('disk-content'))
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

describe('CodeEditor 保存冲突检查——磁盘内容已变二进制', () => {
  // 复现：服务端对二进制文件 read 返回 415 BINARY_FILE（routes/files.ts 字节层拒绝），
  // 而 CodeEditor.save() 的冲突检查把它当「磁盘读取失败」直接 PUT：文件打开时是
  // 文本、磁盘上后来被换成二进制内容时，用户一点保存就把编辑器文本整体覆盖上去，
  // 静默毁掉二进制文件（415 之前是 200 mojibake 读，内容不同尚能触发冲突弹窗兜底）。
  it('read 抛 415/BINARY_FILE：中止保存、不发出写入、错误文案可见', async () => {
    vi.mocked(fileAPI.read).mockRejectedValue(
      apiError(415, 'BINARY_FILE', '这是二进制文件，不能以文本方式显示或编辑'),
    )
    vi.mocked(fileAPI.write).mockResolvedValue({ path: 'a.ts', written: true })
    const { container } = renderEditor({ path: 'a.ts', initial: 'AAA' })
    await waitFor(() => expect(liveView(container)).toBeTruthy())
    liveView(container)?.dispatch({ changes: { from: 0, insert: 'edited-' } })
    await waitFor(() => expect(container.textContent).toContain('保存*'))

    await userEvent.click(
      container.querySelector<HTMLElement>('[data-testid="save"]') as HTMLElement,
    )

    await waitFor(() =>
      expect(container.querySelector('[data-testid="write-error-banner"]')).not.toBeNull(),
    )
    expect(container.textContent).toContain('文件在磁盘上已是二进制内容')
    expect(fileAPI.write).not.toHaveBeenCalled()
  })

  // 对照：冲突检查的 catch 对「其它读失败」维持既有语义——直接写入（文件被移入
  // 回收站等场景写入会重建文件），不弹错误。
  it('其它读失败（文件不存在等）仍直接写入', async () => {
    vi.mocked(fileAPI.read).mockRejectedValue(apiError(404, 'FILE_NOT_FOUND', '文件不存在'))
    vi.mocked(fileAPI.write).mockResolvedValue({ path: 'a.ts', written: true })
    const { container } = renderEditor({ path: 'a.ts', initial: 'AAA' })
    await waitFor(() => expect(liveView(container)).toBeTruthy())
    liveView(container)?.dispatch({ changes: { from: 0, insert: 'edited-' } })
    await waitFor(() => expect(container.textContent).toContain('保存*'))

    await userEvent.click(
      container.querySelector<HTMLElement>('[data-testid="save"]') as HTMLElement,
    )

    await waitFor(() => expect(fileAPI.write).toHaveBeenCalledTimes(1))
    expect(fileAPI.write).toHaveBeenCalledWith('a.ts', 'edited-AAA', undefined)
    expect(container.querySelector('[data-testid="write-error-banner"]')).toBeNull()
    expect(container.textContent).toContain('已保存')
  })
})

describe('CodeEditor 保存请求在途', () => {
  // 复现：save() 成功回调无条件 setDirty(false) + baseRef=请求发起时的 doc 快照，
  // 而按钮只有 disabled={!dirty}、飞行期间仍可点。用户点「保存」后继续敲的字
  // 会被这批响应标成「已保存」——关闭预览不再弹丢弃确认，新字随预览消失。
  it('在途期间的新输入不被标成已保存，且重复点击不再发出第二个 PUT', async () => {
    let resolveWrite: (() => void) | undefined
    vi.mocked(fileAPI.read).mockResolvedValue({ path: 'a.ts', content: 'AAA' })
    vi.mocked(fileAPI.write).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWrite = () => resolve({ path: 'a.ts', written: true })
        }),
    )
    const { container } = renderEditor({ path: 'a.ts', initial: 'AAA' })
    await waitFor(() => expect(liveView(container)).toBeTruthy())

    liveView(container)?.dispatch({ changes: { from: 0, insert: 'first-' } })
    await waitFor(() => expect(container.textContent).toContain('保存*'))

    const saveBtn = () =>
      container.querySelector<HTMLElement>('[data-testid="save"]') as HTMLElement
    await userEvent.click(saveBtn())

    // 在途期间继续编辑（模拟慢磁盘/远端 worktree）
    await waitFor(() => expect(fileAPI.write).toHaveBeenCalledTimes(1))
    liveView(container)?.dispatch({ changes: { from: 0, insert: 'second-' } })

    // 在途期间再次点击：不得发出第二个 PUT
    await userEvent.click(saveBtn())
    expect(fileAPI.write).toHaveBeenCalledTimes(1)

    resolveWrite?.()
    await waitFor(() => expect(saveBtn().textContent).not.toContain('保存中'))

    // 关键断言：飞行期间敲的 second- 仍在文档里，且仍是脏的
    expect(liveView(container)?.state.doc.toString()).toBe('second-first-AAA')
    expect(container.textContent).toContain('保存*')
    expect(saveBtn().hasAttribute('disabled')).toBe(false)
  })
})
