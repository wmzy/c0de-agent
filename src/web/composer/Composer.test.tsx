// 大段粘贴（≥8000 字符 或 ≥120 行）走「先确认再插入」路径：handlePaste 已
// preventDefault 吞掉原生插入，若不渲染确认条并让用户确认，整段文本会静默丢失。
// 这里锁住三个行为：出现确认条且未插入、确认后插入规范化文本、取消后丢弃。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@/composer/Composer.js'
import { draftStorageKey } from '@/composer/draft.js'
import type { ImagePart, Prompt } from '@/composer/types.js'
import { FileSelectionContext } from '@/contexts/FileSelectionContext.js'
import { fileAPI } from '@/services/file.js'
import { storageGet } from '@/utils/storage.js'

vi.mock('@/services/commands.js', () => ({
  commandsAPI: { list: vi.fn().mockResolvedValue({ commands: [] }) },
}))

vi.mock('@/services/workflows.js', () => ({
  workflowsAPI: { list: vi.fn().mockResolvedValue({ workflows: [] }) },
}))

// @ 文件候选来自 /api/files/search（不限条数）：真实仓库一次命中几百个是常态，
// 而浮层只渲染前 20 个。mock 掉服务以驱动这条链路。
vi.mock('@/services/file.js', () => ({
  fileAPI: { search: vi.fn().mockResolvedValue([]) },
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

// 草稿此前只活在内存里：切会话时 ChatSession 先渲染 ChatSkeleton（Composer 整个
// 卸载），刷新整页更是重建组件——未发送的长提示词静默消失，而提示历史只记已发送
// 文本，接不住它。这里锁住「按作用域落盘 + 重挂载回填 + 成功后清除」。
describe('Composer 草稿持久化', () => {
  function DraftHarness({ scope }: { scope: string }) {
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
            draftScope={scope}
          />
        </FileSelectionContext.Provider>
      </QueryClientProvider>
    )
  }

  afterEach(() => {
    localStorage.clear()
  })

  it('未发送的内容在重新挂载（切会话/刷新）后按作用域回填', () => {
    const view = render(<DraftHarness scope="s:one" />)
    fireEvent.input(screen.getByTestId('composer-editor'), {
      target: { textContent: '未发送的草稿' },
    })
    expect(storageGet(draftStorageKey('s:one'))).toContain('未发送的草稿')

    view.unmount()
    render(<DraftHarness scope="s:one" />)
    expect(screen.getByTestId('composer-editor').textContent).toContain('未发送的草稿')
  })

  it('不同作用域之间不串草稿：另一会话不显示上一会话未发送的内容', () => {
    const view = render(<DraftHarness scope="s:one" />)
    fireEvent.input(screen.getByTestId('composer-editor'), {
      target: { textContent: '属于 one 的草稿' },
    })
    view.unmount()

    render(<DraftHarness scope="s:two" />)
    expect(screen.getByTestId('composer-editor').textContent).not.toContain('属于 one 的草稿')
  })

  it('发送成功后清除该作用域的草稿（回填不得复活已发出的消息）', () => {
    const view = render(<DraftHarness scope="s:one" />)
    const editor = screen.getByTestId('composer-editor')
    fireEvent.input(editor, { target: { textContent: '这条要发出去' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(storageGet(draftStorageKey('s:one'))).toBeNull()

    view.unmount()
    render(<DraftHarness scope="s:one" />)
    expect(screen.getByTestId('composer-editor').textContent).not.toContain('这条要发出去')
  })

  /** 粘贴图片（happy-dom 的 ClipboardEvent 不支持 init.clipboardData，手工装配）。 */
  function pasteImage(el: HTMLElement, file: File) {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { items: [{ type: file.type, getAsFile: () => file }], getData: () => '' },
    })
    fireEvent(el, event)
  }

  it('图片附件随草稿一起回填', async () => {
    const view = render(<DraftHarness scope="s:img" />)
    pasteImage(
      screen.getByTestId('composer-editor'),
      new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
    )
    await waitFor(() => expect(screen.getByTestId('attachment-bar')).toBeTruthy())

    view.unmount()
    render(<DraftHarness scope="s:img" />)
    await waitFor(() => expect(screen.getByTestId('attachment-bar')).toBeTruthy())
  })

  it('图片超出持久化预算时只存文本——大量附件不得把文本草稿一起挤掉', async () => {
    const view = render(<DraftHarness scope="s:big" />)
    const editor = screen.getByTestId('composer-editor')
    fireEvent.input(editor, { target: { textContent: '文本要留住' } })
    // base64 后约 1.1MB，超过 MAX_DRAFT_IMAGE_CHARS（512k 字符）
    pasteImage(editor, new File([new Uint8Array(800_000)], 'big.png', { type: 'image/png' }))
    await waitFor(() => expect(screen.getByTestId('attachment-bar')).toBeTruthy())

    view.unmount()
    render(<DraftHarness scope="s:big" />)
    expect(screen.getByTestId('composer-editor').textContent).toContain('文本要留住')
    expect(screen.queryByTestId('attachment-bar')).toBeNull()
  })
})

// @ 提及浮层此前有两份候选：渲染只画前 20 个文件，键盘却按完整搜索结果计数
// （/api/files/search 不限条数，真实仓库 `@a` 一命中几百个）。↓ 按过第 20 项后
// 一个高亮都没有，Enter 仍按完整列表取第 21 项——把用户从未看见的文件静默插进
// prompt 并吃掉 @query。索引空间必须与渲染列表同源。
describe('Composer @ 提及浮层的键盘索引与渲染列表同源', () => {
  const files = Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts`, type: 'file' }))

  async function openAtMenu() {
    vi.mocked(fileAPI.search).mockResolvedValue(files as never)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <FileSelectionContext.Provider
          value={{ selectedFile: null, openFile: () => {}, closeFile: () => {} }}
        >
          <Composer
            onSend={vi.fn()}
            isStreaming={false}
            hasHistory={false}
            agents={[]}
            projectId="p1"
          />
        </FileSelectionContext.Provider>
      </QueryClientProvider>,
    )
    const editor = screen.getByTestId('composer-editor')
    // @ 浮层按光标位置触发：happy-dom 里 setSelectionRange 之类的元素级 API 会把
    // offset 夹到 0（实测 Range.selectNodeContents+collapse(false) 得 offset 1），
    // 只有把 range 起点指到文本节点上，光标偏移才如实反映在编辑器末尾。
    editor.textContent = '@q'
    const text = editor.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    const sel = window.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.input(editor)
    await waitFor(() => expect(screen.getByTestId('at-menu')).toBeTruthy())
    return editor
  }

  it('↓ 走到列表末项后仍有高亮，Enter 插入的是被渲染出来的那一项', async () => {
    const editor = await openAtMenu()
    const menu = screen.getByTestId('at-menu')
    expect(menu.querySelectorAll('[role="option"]')).toHaveLength(20)
    const rendered = Array.from(menu.querySelectorAll('[role="option"]')).map((n) => n.textContent)

    // 一路 ↓ 到超过 20 项：高亮必须停在最后一项，不能消失
    for (let i = 0; i < 25; i++) {
      fireEvent.keyDown(editor, { key: 'ArrowDown' })
    }
    const selected = menu.querySelectorAll('[aria-selected="true"]')
    expect(selected).toHaveLength(1)
    const highlighted = selected[0]?.textContent ?? ''

    fireEvent.keyDown(editor, { key: 'Enter' })
    // 提交的就是高亮的那一项——不是「第 21 个用户没看见的文件」
    expect(editor.textContent).toContain(highlighted as string)
    expect(rendered).toContain(highlighted as string)
    // 末项 = 第 20 个：绝不该出现第 21 个（它从未被渲染）
    expect(editor.textContent).not.toContain('src/f20.ts')
  })

  it('高亮项随 ↓ 在已渲染的候选间移动（高亮空间 = 渲染列表）', async () => {
    const editor = await openAtMenu()
    const menu = screen.getByTestId('at-menu')
    expect(menu.querySelector('[aria-selected="true"]')?.textContent).toBe('src/f0.ts')

    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    expect(menu.querySelector('[aria-selected="true"]')?.textContent).toBe('src/f2.ts')

    fireEvent.keyDown(editor, { key: 'ArrowUp' })
    expect(menu.querySelector('[aria-selected="true"]')?.textContent).toBe('src/f1.ts')
  })
})

// 搜索请求在途时候选计数为 0，此前与「搜完了没有匹配」共用一条 return null：
// 浮层整个消失（用户以为没有匹配），且 popoverDead 判定生效后 Enter 退化成
// 「发送字面量 @query 文本」。这里锁住两点：搜索中浮层给出「搜索中…」反馈，
// 且此时按键不被一个出不来结果的菜单吞掉（Enter 仍然发送）。
describe('Composer @ 浮层在文件搜索在途时的加载态', () => {
  function renderWithSearch(search: () => Promise<never>) {
    vi.mocked(fileAPI.search).mockImplementation(search)
    const onSend = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <FileSelectionContext.Provider
          value={{ selectedFile: null, openFile: () => {}, closeFile: () => {} }}
        >
          <Composer
            onSend={onSend}
            isStreaming={false}
            hasHistory={false}
            agents={[]}
            projectId="p1"
          />
        </FileSelectionContext.Provider>
      </QueryClientProvider>,
    )
    return { editor: screen.getByTestId('composer-editor'), onSend }
  }

  it('搜索在途时浮层显示「搜索中」而不是消失', async () => {
    const { editor } = renderWithSearch(() => new Promise(() => {}))
    editor.textContent = '@q'
    const text = editor.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    const sel = window.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.input(editor)

    await waitFor(() => expect(screen.getByTestId('at-menu-loading')).toBeTruthy())
    expect(screen.getByTestId('at-menu-loading').textContent).toContain('搜索中')
  })

  it('搜索在途时 Enter 不会被浮层吞掉（消息照常发出）', async () => {
    const { editor, onSend } = renderWithSearch(() => new Promise(() => {}))
    editor.textContent = '@q'
    const text = editor.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    const sel = window.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.input(editor)
    await waitFor(() => expect(screen.getByTestId('at-menu-loading')).toBeTruthy())

    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalled())
  })
})

/**
 * 工具权限请求的到达是一个「需要用户介入」的状态变化（run 停在这一步等确认），
 * 因此 dock 必须被当成 alertdialog：挂载即接管焦点、Esc 等价拒绝、关闭后焦点
 * 回到输入框。此前是无 role 的普通 div——焦点留在输入框、读屏无播报、Esc 不通。
 */
describe('Composer 工具权限确认 dock 的到达/拒绝可达性', () => {
  function renderWithPermission(onPermissionCancel: () => void, onPermissionConfirm = vi.fn()) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (permission: { tool: string; input: unknown } | null) => (
      <QueryClientProvider client={qc}>
        <FileSelectionContext.Provider
          value={{ selectedFile: null, openFile: () => {}, closeFile: () => {} }}
        >
          <Composer
            onSend={vi.fn()}
            isStreaming
            hasHistory
            agents={[]}
            permission={permission}
            permissionAllowAlways
            onPermissionConfirm={onPermissionConfirm}
            onPermissionCancel={onPermissionCancel}
          />
        </FileSelectionContext.Provider>
      </QueryClientProvider>
    )
    const { rerender } = render(view(null))
    return {
      editor: screen.getByTestId('composer-editor'),
      onPermissionConfirm,
      /** 复刻真实时序：焦点先落在输入框，权限请求随后到达。 */
      requestPermission: () => rerender(view({ tool: 'bash', input: { command: 'rm -rf /' } })),
      dock: () => screen.getByTestId('permission-dock'),
    }
  }

  it('挂载即成为 alertdialog 并接管焦点（读屏播报标题与入参）', async () => {
    const { editor, requestPermission, dock } = renderWithPermission(vi.fn())
    editor.focus()
    requestPermission()
    await waitFor(() => expect(document.activeElement).toBe(dock()))
    expect(dock().getAttribute('role')).toBe('alertdialog')
    const labelId = dock().getAttribute('aria-labelledby') as string
    expect(document.getElementById(labelId)?.textContent).toContain('bash')
    expect(
      document.getElementById(dock().getAttribute('aria-describedby') as string)?.textContent,
    ).toContain('rm -rf /')
  })

  it('Esc 拒绝该次请求（键盘用户不必瞄准按钮）', async () => {
    const onCancel = vi.fn()
    const { editor, requestPermission, dock } = renderWithPermission(onCancel)
    editor.focus()
    requestPermission()
    await waitFor(() => expect(document.activeElement).toBe(dock()))
    fireEvent.keyDown(dock(), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('允许按钮仍走确认回调，不被 Esc 语义吞掉', async () => {
    const onConfirm = vi.fn()
    const { editor, requestPermission, dock } = renderWithPermission(vi.fn(), onConfirm)
    editor.focus()
    requestPermission()
    await waitFor(() => expect(document.activeElement).toBe(dock()))
    fireEvent.click(screen.getByText('允许'))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })
})
