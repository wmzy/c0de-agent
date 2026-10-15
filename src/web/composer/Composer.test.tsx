// 大段粘贴（≥8000 字符 或 ≥120 行）走「先确认再插入」路径：handlePaste 已
// preventDefault 吞掉原生插入，若不渲染确认条并让用户确认，整段文本会静默丢失。
// 这里锁住三个行为：出现确认条且未插入、确认后插入规范化文本、取消后丢弃。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@/composer/Composer.js'
import { draftStorageKey, saveDraft } from '@/composer/draft.js'
import type { ImagePart, Prompt } from '@/composer/types.js'
import { FileSelectionContext } from '@/contexts/FileSelectionContext.js'
import { commandsAPI } from '@/services/commands.js'
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

/**
 * 拖放文本此前是一条与粘贴割裂的旁路：裸 document.execCommand('insertText')，
 * 不走 normalizePaste 与大段确认条——拖一个 1MB 的 .log 进来直接灌满输入框，
 * 而同样内容 Ctrl+V 会先问一句；且同一批里带图片文件时文本被整段丢弃。
 * 契约：拖放与粘贴共用一条插入通道（归一 + 大段确认），图片与文本互不吞。
 */
describe('Composer 拖放文本入框', () => {
  /** happy-dom 的 DragEvent 不带 dataTransfer，直接构造原生事件注入。 */
  function dropFiles(editor: HTMLElement, files: File[], text: string) {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { files, getData: () => text },
    })
    fireEvent(editor.parentElement as HTMLElement, event)
  }

  it('拖放文本插入编辑器，焦点落在编辑器上（用户可继续直接打字）', () => {
    const editor = renderComposer()
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    elsewhere.focus()

    dropFiles(editor, [], 'dropped line')

    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'dropped line')
    expect(document.activeElement).toBe(editor)
    elsewhere.remove()
  })

  it('拖放同样归一换行，并对大段内容弹确认条而非直接灌入', () => {
    const editor = renderComposer()
    dropFiles(editor, [], LARGE)

    expect(execCommand).not.toHaveBeenCalled()
    const bar = screen.getByTestId('paste-confirm')
    expect(bar.textContent).toContain(`${LARGE.length} 字符`)
    fireEvent.click(screen.getByTestId('paste-confirm-insert'))
    expect(execCommand).toHaveBeenCalledWith('insertText', false, `${'x'.repeat(9000)}\nsecond`)
  })

  it('同批既有图片又有文本时两者都处理，文本不被丢弃', async () => {
    const editor = renderComposer()
    const png = new File(['x'], 'a.png', { type: 'image/png' })
    dropFiles(editor, [png], 'kept text')

    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'kept text')
    // 图片走异步读取，附件栏随之出现
    await waitFor(() => expect(screen.getByTestId('attachment-bar').textContent).toContain('1 张'))
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
 * 候选源读取失败：此前与「没有匹配」渲染完全一致（浮层消失/空列表），用户据此
 * 以为文件/命令不存在，按 Enter 还把字面量 `@foo` / `/cmd` 当正文发出去。
 */
describe('Composer 浮层候选源读取失败时的错误态', () => {
  function typeToken(editor: HTMLElement, text: string) {
    editor.textContent = text
    const node = editor.firstChild as Text
    const range = document.createRange()
    range.setStart(node, text.length)
    range.collapse(true)
    const sel = window.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.input(editor)
  }

  function renderFailed() {
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

  afterEach(() => {
    vi.mocked(fileAPI.search).mockResolvedValue([] as never)
    vi.mocked(commandsAPI.list).mockResolvedValue({ commands: [] } as never)
  })

  it('文件搜索失败时浮层显示原因，而不是渲染成「没有匹配」', async () => {
    vi.mocked(fileAPI.search).mockRejectedValue(new Error('搜索服务炸了'))
    const { editor } = renderFailed()
    typeToken(editor, '@rea')

    await waitFor(() => expect(screen.getByTestId('at-menu-error')).toBeTruthy())
    expect(screen.getByTestId('at-menu-error').textContent).toContain('搜索服务炸了')
    // 不是空浮层、也不是「搜索中」——两者都会让用户以为没有匹配。
    expect(screen.queryByTestId('at-menu')).toBeNull()
    expect(screen.queryByTestId('at-menu-loading')).toBeNull()
  })

  it('失败态下 Enter 仍把消息发出去（不被浮层吞掉）', async () => {
    vi.mocked(fileAPI.search).mockRejectedValue(new Error('boom'))
    const { editor, onSend } = renderFailed()
    typeToken(editor, '@rea')
    await waitFor(() => expect(screen.getByTestId('at-menu-error')).toBeTruthy())

    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalled())
  })

  it('点失败行的「重试」后候选恢复（用户不必重打一遍）', async () => {
    vi.mocked(fileAPI.search)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([{ path: 'src/a.ts', type: 'file' }] as never)
    const { editor } = renderFailed()
    typeToken(editor, '@a')
    await waitFor(() => expect(screen.getByTestId('at-menu-error')).toBeTruthy())

    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(screen.getByTestId('at-menu')).toBeTruthy())
  })

  it('斜杠命令列表读取失败时同样给出原因与重试', async () => {
    vi.mocked(commandsAPI.list).mockRejectedValue(new Error('命令服务不可用'))
    const { editor } = renderFailed()
    typeToken(editor, '/')

    await waitFor(() => expect(screen.getByTestId('slash-menu-error')).toBeTruthy())
    expect(screen.getByTestId('slash-menu-error').textContent).toContain('命令服务不可用')
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

// 浮层是否打开只在「输入事件」里重算：键入 `@read` 出候选后，用 Home / 方向键 /
// 鼠标点回文本中间，菜单不会失效。此前 Enter 分支无条件 preventDefault 再调
// insert*，而 insert* 找不到光标前的 @token 就静默 return——消息永远发不出去、
// 浮层不关、连按 Enter 也毫无反应（真实浏览器实测复现），只有 Esc/鼠标能脱身。
// 契约：候选插不进去时把按键放行，回到「无浮层」语义（Enter = 发送）。
describe('Composer 浮层候选插不进去时不再吞掉 Enter', () => {
  function renderForAtMenu() {
    vi.mocked(fileAPI.search).mockResolvedValue([{ path: 'src/f0.ts', type: 'file' }] as never)
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

  /** 复刻「键入 @query 出候选」：happy-dom 的 selection API 会把光标夹到 0，
   *  必须把 range 起点指到文本节点上，光标偏移才如实反映。 */
  function typeAtQuery(editor: HTMLElement) {
    editor.textContent = '@q'
    const text = editor.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    const sel = window.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.input(editor)
  }

  /** 把光标移到 @token 之前（浮层状态不会随之失效）。 */
  function moveCursorToStart(editor: HTMLElement) {
    const text = editor.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 0)
    range.collapse(true)
    const sel = window.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
  }

  it('光标离开 @token 后按 Enter：浮层关闭，消息照常发出（不再是静默无反应）', async () => {
    const { editor, onSend } = renderForAtMenu()
    typeAtQuery(editor)
    await waitFor(() => expect(screen.getByTestId('at-menu')).toBeTruthy())

    moveCursorToStart(editor)
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('at-menu')).toBeNull()
    // 发送的是用户写的字面文本——不是「什么都没发生」
    expect(onSend.mock.calls[0]?.[0].text).toContain('@q')
  })

  it('光标仍在 @token 上时 Enter 仍然插入候选（正常路径不受影响）', async () => {
    const { editor, onSend } = renderForAtMenu()
    typeAtQuery(editor)
    await waitFor(() => expect(screen.getByTestId('at-menu')).toBeTruthy())

    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(editor.textContent).toContain('src/f0.ts'))
    expect(onSend).not.toHaveBeenCalled()
  })
})

// Tab 是「离开输入框」的键。子命令浮层打开时按 Tab 会走 Composer 的 Tab 分支把
// 浮层关掉，但 useComposer 里有「commands 就绪 / popover 变化后按同一段文本重新
// 检测」的 effect——裸 setPopover(null) 不记 dismissed，菜单在焦点移走的同一瞬间
// 原样弹回来，Tab 成了死键；Esc 因为记了 dismissed 不会重现，用户学到的规则失效。
describe('Composer Tab 关浮层后不会被重新检测弹回来', () => {
  function typeText(editor: HTMLElement, text: string) {
    editor.textContent = text
    const node = editor.firstChild as Text
    const range = document.createRange()
    range.setStart(node, text.length)
    range.collapse(true)
    const sel = window.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.input(editor)
  }

  function renderWithSubcommand() {
    vi.mocked(commandsAPI.list).mockResolvedValue({
      commands: [
        {
          name: 'git',
          description: 'git 子命令',
          subcommands: [
            { name: 'status', description: '查看状态' },
            { name: 'commit', description: '提交' },
          ],
        },
      ],
    } as never)
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

  it('Tab 关掉子命令浮层后它不再自己弹回来', async () => {
    const editor = renderWithSubcommand()
    typeText(editor, '/git ')
    await waitFor(() => expect(screen.getByTestId('subcommand-menu')).toBeTruthy())

    fireEvent.keyDown(editor, { key: 'Tab' })

    await waitFor(() => expect(screen.queryByTestId('subcommand-menu')).toBeNull())
    // 再等一拍：重检测 effect 是在 popover 变 null 之后跑的，修复前它会在此把
    // 同一个菜单弹回来（这条断言就是死键的钉子）
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('subcommand-menu')).toBeNull()
  })

  it('Esc 与 Tab 关掉的是同一个浮层（两条路径都不弹回）', async () => {
    const editor = renderWithSubcommand()
    typeText(editor, '/git ')
    await waitFor(() => expect(screen.getByTestId('subcommand-menu')).toBeTruthy())

    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(screen.queryByTestId('subcommand-menu')).toBeNull()

    // 用户继续把这段文本改成别的子命令查询——新的输入意图应重新获得补全
    typeText(editor, '/git s')
    await waitFor(() => expect(screen.getByTestId('subcommand-menu')).toBeTruthy())
  })
})

/**
 * 未定的交互状态不跨作用域（切会话 / 切草稿页项目）。
 *
 * 此前 send() 的失败还原只认「发送世代」（sendAttemptRef：又发了一次才作废），
 * 而切会话不改它——hook 实例也不随会话切换重建（目标会话的消息已在 react-query
 * 缓存里时不走 ChatSkeleton 早返回）。于是「在 A 发消息 → 请求还没回来就点开 B」
 * 时，A 那次失败回来会在 B 的输入框里回填 A 的正文与图片，并（persist=true）
 * 把它写成 B 的草稿（刷新后还在）：同一段文字被记在两条会话头上。同一根因还让
 * 「大段粘贴确认条」整条留着——它的正文来自 A，点「插入」就灌进 B。
 *
 * 修法：草稿作用域世代号（scopeGenRef）。作用域一变，在途请求落地时一律作废。
 */
describe('Composer 未定的交互状态不跨作用域', () => {
  function ScopeHarness({
    scope,
    onSend,
    onSteer,
  }: {
    scope: string
    onSend: () => boolean | undefined | Promise<boolean | undefined>
    onSteer?: (message: string) => boolean | undefined | Promise<boolean | undefined>
  }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return (
      <QueryClientProvider client={qc}>
        <FileSelectionContext.Provider
          value={{ selectedFile: null, openFile: () => {}, closeFile: () => {} }}
        >
          <Composer
            onSend={onSend}
            onSteer={onSteer}
            isStreaming={onSteer !== undefined}
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

  it('A 的发送失败不回填进切过去之后的 B，而是落回 A 自己的草稿', async () => {
    let settle: ((ok: boolean) => void) | undefined
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        }),
    )
    const view = render(<ScopeHarness scope="s:one" onSend={onSend} />)
    const editor = screen.getByTestId('composer-editor')
    fireEvent.input(editor, { target: { textContent: '属于 A 的正文' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(editor.textContent).not.toContain('属于 A 的正文')

    // 请求在途期间切到 B（同一实例，复刻「B 的消息已在缓存里，不走骨架页」）
    view.rerender(<ScopeHarness scope="s:two" onSend={onSend} />)
    settle?.(false)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // 不写进 B：正文与草稿都不能沾
    expect(editor.textContent).not.toContain('属于 A 的正文')
    expect(storageGet(draftStorageKey('s:two'))).toBeNull()
    // 也不能丢：落回 A 自己的草稿，回去时输入框里还是这段文字
    expect(storageGet(draftStorageKey('s:one'))).toContain('属于 A 的正文')
    view.rerender(<ScopeHarness scope="s:one" onSend={onSend} />)
    expect(editor.textContent).toContain('属于 A 的正文')
  })

  it('未切作用域时失败仍原样还回输入（守卫不得误伤这条既有承诺）', async () => {
    let settle: ((ok: boolean) => void) | undefined
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        }),
    )
    render(<ScopeHarness scope="s:one" onSend={onSend} />)
    const editor = screen.getByTestId('composer-editor')
    fireEvent.input(editor, { target: { textContent: '失败要还回来' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    settle?.(false)

    await waitFor(() => expect(editor.textContent).toContain('失败要还回来'))
    expect(storageGet(draftStorageKey('s:one'))).toContain('失败要还回来')
  })

  it('A 的大段粘贴确认条不跟到 B', () => {
    const view = render(<ScopeHarness scope="s:one" onSend={vi.fn()} />)
    const editor = screen.getByTestId('composer-editor')
    pasteText(editor, LARGE)
    expect(screen.getByTestId('paste-confirm')).toBeTruthy()

    view.rerender(<ScopeHarness scope="s:two" onSend={vi.fn()} />)

    // 确认条的正文来自 A；留着它，点「插入」就把 A 粘贴的内容写进 B 的输入框。
    expect(screen.queryByTestId('paste-confirm')).toBeNull()
  })

  it('A 的追加指令落地时不清掉 B 的草稿（同文也不行）', async () => {
    let settle: ((ok: boolean) => void) | undefined
    const onSteer = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        }),
    )
    // B 已有一份与 A 这段指令同文的草稿：清空判定比的是「输入框里还是不是那段文字」，
    // 同文就会命中——跨作用域时必须先按世代作废。
    saveDraft('s:two', [{ type: 'text', content: '同一段指令', start: 0, end: 5 }], [])

    const view = render(<ScopeHarness scope="s:one" onSend={vi.fn()} onSteer={onSteer} />)
    const editor = screen.getByTestId('composer-editor')
    fireEvent.input(editor, { target: { textContent: '同一段指令' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(onSteer).toHaveBeenCalledTimes(1)

    view.rerender(<ScopeHarness scope="s:two" onSend={vi.fn()} onSteer={onSteer} />)
    expect(editor.textContent).toContain('同一段指令')

    settle?.(true)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(editor.textContent).toContain('同一段指令')
    expect(storageGet(draftStorageKey('s:two'))).toContain('同一段指令')
  })
})

/**
 * Shift+Enter 是「换行」，不是「确认候选」。
 *
 * 四个浮层的 Enter 分支此前只判 `e.key === 'Enter'`，命中候选后立刻 preventDefault
 * 并插入——于是浮层开着时按 Shift+Enter 得到的是「插入候选 + 不换行 + 已打的字被
 * 静默改写」：`/hel` 变成 `/help `，`@src` 变成某个具体文件路径。用户想要的换行
 * 没有出现，反而丢了刚打的字（且浮层看起来「自己选中了第一条」）。口径与
 * useComposer 的发送分支一致：Shift+Enter 留给换行，确认候选只认裸 Enter。
 */
describe('Composer 浮层打开时 Shift+Enter 不确认候选', () => {
  function typeToken(editor: HTMLElement, text: string) {
    editor.textContent = text
    const node = editor.firstChild as Text
    const range = document.createRange()
    range.setStart(node, text.length)
    range.collapse(true)
    const sel = window.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    fireEvent.input(editor)
  }

  function renderPopover() {
    vi.mocked(fileAPI.search).mockResolvedValue([{ path: 'src/f0.ts', type: 'file' }] as never)
    vi.mocked(commandsAPI.list).mockResolvedValue({
      commands: [
        { name: 'help', description: '帮助' },
        { name: 'hello', description: '打招呼' },
      ],
    } as never)
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

  afterEach(() => {
    vi.mocked(fileAPI.search).mockResolvedValue([] as never)
    vi.mocked(commandsAPI.list).mockResolvedValue({ commands: [] } as never)
  })

  it('@ 浮层开着时 Shift+Enter 不改写已打的字、也不发送', async () => {
    const { editor, onSend } = renderPopover()
    typeToken(editor, '@src')
    await waitFor(() => expect(screen.getByTestId('at-menu')).toBeTruthy())

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })

    expect(editor.textContent).toBe('@src')
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByTestId('at-menu')).toBeTruthy()
  })

  it('斜杠浮层开着时 Shift+Enter 不把 /hel 改写成 /help ', async () => {
    const { editor, onSend } = renderPopover()
    typeToken(editor, '/hel')
    await waitFor(() => expect(screen.getByTestId('slash-menu')).toBeTruthy())

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })

    expect(editor.textContent).toBe('/hel')
    expect(onSend).not.toHaveBeenCalled()
  })

  it('同一浮层里裸 Enter 仍然确认候选（Shift 只是不放行发送，不影响确认）', async () => {
    const { editor, onSend } = renderPopover()
    typeToken(editor, '@src')
    await waitFor(() => expect(screen.getByTestId('at-menu')).toBeTruthy())

    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => expect(editor.textContent).toContain('src/f0.ts'))
    expect(onSend).not.toHaveBeenCalled()
  })
})
