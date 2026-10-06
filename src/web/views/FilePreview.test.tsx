import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createRoutes, MemoryRouter, TypedLink, View } from '@native-router/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type FileChangeGuard,
  type FileSelection,
  FileSelectionContext,
} from '@/contexts/FileSelectionContext.js'
import { ReferenceContext } from '@/contexts/ReferenceContext.js'
import { ThemeProvider } from '@/contexts/ThemeContext.js'
import type { AppPaths } from '@/routes.js'
import { computeLineRange, FilePreview } from '@/views/FilePreview.js'

// mock CodeEditor：本文件聚焦 FilePreview 行为（脏关闭守卫等），
// 通过 mock-dirty 按钮驱动 onDirtyChange，避免在 jsdom 中模拟 CodeMirror 输入。
vi.mock('../components/CodeEditor.js', () => ({
  CodeEditor: ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) => (
    <div data-testid="code-editor">
      <button type="button" data-testid="mock-dirty" onClick={() => onDirtyChange?.(true)}>
        标记脏
      </button>
    </div>
  ),
}))

// 返回 mock fetch，json 响应携带给定 content
function fetchMock(content: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ path: 'x', content }),
    text: async () => JSON.stringify({ path: 'x', content }),
  })
}

/** 只有会卸载预览面板的导航才该被拦：同项目的两个聊天路由之间切换保留 ChatPage，
 *  因此测试路由表把三者区分成不同探针，用于断言「导航真的提交了」。 */
const previewTestRoutes = createRoutes({
  children: [
    { path: '/projects/:projectId', component: () => ChatRouteProbe },
    { path: '/projects/:projectId/sessions/:sessionId', component: () => SessionRouteProbe },
    { path: '/projects/:projectId/settings', component: () => SettingsRouteProbe },
  ],
})

function ChatRouteProbe() {
  return <div data-testid="chat-route" />
}

function SessionRouteProbe() {
  return <div data-testid="session-route" />
}

function SettingsRouteProbe() {
  return <div data-testid="settings-route" />
}

/** MemoryRouter 的初始条目：聊天路由（面板会被保留）与离开路由（会卸载面板）各一。 */
const ENTRY_CHAT = '/projects/p1'
const ENTRY_SESSION = '/projects/p1/sessions/s1'

const baseSelection: FileSelection = {
  selectedFile: null,
  openFile: () => {},
  closeFile: () => {},
}

/**
 * FilePreview 现在用 useBlocker 做未保存导航防护，必须有 Router 上下文；
 * QueryClient + FileSelectionContext 也一并收敛在这里，避免各用例重复样板。
 */
function PreviewProviders({
  children,
  selection,
  entry = ENTRY_CHAT,
}: {
  children: React.ReactNode
  selection?: Partial<FileSelection>
  entry?: string
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (
    <MemoryRouter routes={previewTestRoutes} initialEntries={[entry]}>
      <QueryClientProvider client={qc}>
        <FileSelectionContext.Provider value={{ ...baseSelection, ...selection }}>
          <View />
          {children}
        </FileSelectionContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

function withClient(ui: React.ReactNode, closeFile = () => {}) {
  render(<PreviewProviders selection={{ selectedFile: null, closeFile }}>{ui}</PreviewProviders>)
}

/** 带自定义选中态/初始路由的挂载入口。 */
function renderPreview(
  selection: Partial<FileSelection>,
  node: React.ReactNode,
  entry = ENTRY_CHAT,
) {
  return render(
    <PreviewProviders selection={selection} entry={entry}>
      {node}
    </PreviewProviders>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FilePreview', () => {
  it('渲染 markdown 文件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ path: 'a.md', content: '# Title' }),
        text: async () => JSON.stringify({ path: 'a.md', content: '# Title' }),
      }),
    )
    withClient(<FilePreview projectId="p1" path="a.md" />)
    await waitFor(() => {
      expect(screen.getByText('加载中…')).toBeTruthy()
    })
  })

  it('渲染音频文件为内联播放器', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ path: 'song.mp3', content: '' }),
        text: async () => JSON.stringify({ path: 'song.mp3', content: '' }),
      }),
    )
    withClient(<FilePreview projectId="p1" path="song.mp3" />)
    const audio = document.querySelector('audio')
    expect(audio).toBeTruthy()
    expect(audio?.getAttribute('src')).toContain('/api/files/song.mp3/raw')
  })

  it('渲染视频文件为内联播放器', async () => {
    withClient(<FilePreview projectId="p1" path="clip.mp4" />)
    const video = document.querySelector('video')
    expect(video).toBeTruthy()
    expect(video?.getAttribute('src')).toContain('/api/files/clip.mp4/raw')
  })

  it('图片 src 指向 /raw 端点', async () => {
    withClient(<FilePreview projectId="p1" path="a.png" />)
    const img = document.querySelector('img')
    expect(img).toBeTruthy()
    expect(img?.getAttribute('src')).toContain('/api/files/a.png/raw')
  })

  // 回归：读失败此前没有分支，useQuery 重试耗尽后落到「无内容」——header 仍显示
  // 路径，用户会把 404/500/断网当成文件被清空。必须与真正的空文件区分开。
  it('读取失败展示失败态与后端 message，而不是「无内容」', async () => {
    const errBody = { error: { code: 'NOT_FOUND', message: '文件不存在：a.ts' } }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => errBody,
        text: async () => JSON.stringify(errBody),
        clone: () => ({ json: async () => errBody }),
      }),
    )
    withClient(<FilePreview projectId="p1" path="a.ts" />)
    await waitFor(() => {
      expect(screen.getByTestId('file-preview-error')).toBeTruthy()
    })
    expect(screen.queryByText('无内容')).toBeNull()
    expect(screen.getByText('文件读取失败')).toBeTruthy()
    expect(screen.getByText('文件不存在：a.ts')).toBeTruthy()
    expect(screen.queryByText('[object Object]')).toBeNull()
  })

  it('失败态「重试」重新发起读取', async () => {
    const errBody = { error: { code: 'INTERNAL', message: '磁盘读取失败' } }
    const fetchStub = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => errBody,
      text: async () => JSON.stringify(errBody),
      clone: () => ({ json: async () => errBody }),
    })
    vi.stubGlobal('fetch', fetchStub)
    withClient(<FilePreview projectId="p1" path="a.ts" />)
    await waitFor(() => {
      expect(screen.getByTestId('file-preview-retry')).toBeTruthy()
    })
    const callsBefore = fetchStub.mock.calls.length
    fireEvent.click(screen.getByTestId('file-preview-retry'))
    await waitFor(() => {
      expect(fetchStub.mock.calls.length).toBeGreaterThan(callsBefore)
    })
  })

  // 回归：encodeURI 不编码 ?/#，含它们的文件名会在 URL 中被解析为
  // query/fragment，服务端拿到截断路径读错文件；逐段 encodeFilePath 后
  // src 携带完整编码路径。
  it('文件名含 ? 时 src 路径逐段编码（不被解析为 query）', async () => {
    withClient(<FilePreview projectId="p1" path="dir/a?b.png" />)
    const img = document.querySelector('img')
    expect(img?.getAttribute('src')).toContain('/api/files/dir/a%3Fb.png/raw')
  })

  it('文件名含 # 时 src 路径逐段编码（不被解析为 fragment）', async () => {
    withClient(<FilePreview projectId="p1" path="c#d.png" />)
    const img = document.querySelector('img')
    expect(img?.getAttribute('src')).toContain('/api/files/c%23d.png/raw')
  })

  it('P1：认证 token 存在时媒体 src 附加 ?token=（媒体元素无法携带 Authorization 头）', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'c0de-auth-token' ? 'device-tok-123' : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    withClient(<FilePreview projectId="p1" path="a.png" />)
    const img = document.querySelector('img')
    const src = img?.getAttribute('src') ?? ''
    expect(src).toContain('/api/files/a.png/raw')
    expect(src).toContain('projectId=p1')
    expect(src).toContain(`token=${encodeURIComponent('device-tok-123')}`)
    // token 不应出现在非媒体（CodeEditor）路径的读取请求里
    renderPreview({ selectedFile: 'notes.txt' }, <FilePreview projectId="p1" path="notes.txt" />)
  })

  it('渲染 header 显示路径', async () => {
    vi.stubGlobal('fetch', fetchMock('# Title'))
    withClient(<FilePreview projectId="p1" path="readme.md" />)
    await waitFor(() => {
      expect(screen.getByTestId('preview-path').textContent).toBe('readme.md')
    })
  })

  it('点击关闭按钮调用 closeFile', async () => {
    const closeFile = vi.fn()
    vi.stubGlobal('fetch', fetchMock('# Title'))
    renderPreview(
      { selectedFile: 'readme.md', closeFile },
      <FilePreview projectId="p1" path="readme.md" />,
    )
    await waitFor(() => {
      expect(screen.getByLabelText('关闭预览')).toBeTruthy()
    })
    fireEvent.click(screen.getByLabelText('关闭预览'))
    expect(closeFile).toHaveBeenCalledOnce()
  })

  it('脏编辑点关闭弹出确认弹窗，取消后保留编辑内容', async () => {
    const closeFile = vi.fn()
    vi.stubGlobal('fetch', fetchMock('line1\nline2'))
    renderPreview(
      { selectedFile: 'notes.txt', closeFile },
      <FilePreview projectId="p1" path="notes.txt" />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeTruthy()
    })
    // 标记编辑器为脏后点 ✕：应弹确认而非直接关闭
    fireEvent.click(screen.getByTestId('mock-dirty'))
    fireEvent.click(screen.getByLabelText('关闭预览'))
    expect(screen.getByTestId('discard-dialog')).toBeTruthy()
    expect(screen.getByText('放弃未保存的修改？')).toBeTruthy()
    expect(closeFile).not.toHaveBeenCalled()
    // 取消：弹窗关闭，编辑内容仍在
    fireEvent.click(screen.getByTestId('discard-cancel'))
    expect(screen.queryByTestId('discard-dialog')).toBeNull()
    expect(closeFile).not.toHaveBeenCalled()
    expect(screen.getByTestId('code-editor')).toBeTruthy()
    expect(screen.getByTestId('preview-path').textContent).toBe('notes.txt')
  })

  it('确认放弃未保存修改后才关闭预览', async () => {
    const closeFile = vi.fn()
    vi.stubGlobal('fetch', fetchMock('line1\nline2'))
    renderPreview(
      { selectedFile: 'notes.txt', closeFile },
      <FilePreview projectId="p1" path="notes.txt" />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('mock-dirty'))
    fireEvent.click(screen.getByLabelText('关闭预览'))
    fireEvent.click(screen.getByTestId('discard-confirm'))
    expect(closeFile).toHaveBeenCalledOnce()
  })

  // 切换预览目标的守卫：父组件（ChatPage）改选中态前先调用 FilePreview 注册的钩子，
  // 返回 false 即拦下本次切换，由 FilePreview 弹确认；用户确认后再重放。
  // 缺了这条路径，点文件树里的另一个文件就会把未保存的编辑连同撤销历史一起丢掉。
  describe('未保存编辑时切换预览目标', () => {
    function renderWithGuard(path: string) {
      const closeFile = vi.fn()
      const openFile = vi.fn()
      const hooks: { guard: FileChangeGuard | null } = { guard: null }
      renderPreview(
        {
          selectedFile: path,
          openFile,
          closeFile,
          registerGuard: (fn) => {
            hooks.guard = fn
          },
        },
        <FilePreview projectId="p1" path={path} />,
      )
      return { hooks, closeFile, openFile }
    }

    it('脏编辑时切换被拦下：弹确认、不切换；取消后编辑仍在', async () => {
      vi.stubGlobal('fetch', fetchMock('line1\nline2'))
      const { hooks, openFile } = renderWithGuard('notes.txt')
      await screen.findByTestId('code-editor')
      // 非脏态：放行，且不弹确认
      expect(hooks.guard?.({ path: 'other.txt' })).toBe(true)
      expect(screen.queryByTestId('discard-dialog')).toBeNull()

      fireEvent.click(screen.getByTestId('mock-dirty'))
      await act(async () => {
        expect(hooks.guard?.({ path: 'other.txt' })).toBe(false)
      })
      expect(screen.getByTestId('discard-dialog')).toBeTruthy()
      expect(screen.getByText('放弃未保存的修改？')).toBeTruthy()
      expect(screen.getByText(/切换到「other.txt」/)).toBeTruthy()
      expect(openFile).not.toHaveBeenCalled()

      fireEvent.click(screen.getByTestId('discard-cancel'))
      expect(screen.queryByTestId('discard-dialog')).toBeNull()
      expect(openFile).not.toHaveBeenCalled()
      expect(screen.getByTestId('code-editor')).toBeTruthy()
      expect(screen.getByTestId('preview-path').textContent).toBe('notes.txt')
    })

    it('确认放弃后重放被拦下的切换', async () => {
      vi.stubGlobal('fetch', fetchMock('line1\nline2'))
      const { hooks, openFile } = renderWithGuard('notes.txt')
      await screen.findByTestId('code-editor')

      fireEvent.click(screen.getByTestId('mock-dirty'))
      await act(async () => {
        hooks.guard?.({ path: 'other.txt' })
      })
      fireEvent.click(screen.getByTestId('discard-confirm'))
      expect(openFile).toHaveBeenCalledWith('other.txt', undefined)
    })

    it('同一文件只换高亮范围（点 snippet pill）不弹确认', async () => {
      vi.stubGlobal('fetch', fetchMock('line1\nline2'))
      const { hooks } = renderWithGuard('notes.txt')
      await screen.findByTestId('code-editor')

      fireEvent.click(screen.getByTestId('mock-dirty'))
      expect(hooks.guard?.({ path: 'notes.txt', range: { start: 3, end: 5 } })).toBe(true)
      expect(screen.queryByTestId('discard-dialog')).toBeNull()
    })

    it('脏编辑时删除当前文件（关闭预览）也先确认', async () => {
      vi.stubGlobal('fetch', fetchMock('line1\nline2'))
      const { hooks, closeFile } = renderWithGuard('notes.txt')
      await screen.findByTestId('code-editor')

      fireEvent.click(screen.getByTestId('mock-dirty'))
      await act(async () => {
        expect(hooks.guard?.(null)).toBe(false)
      })
      expect(screen.getByTestId('discard-dialog')).toBeTruthy()
      expect(screen.getByText(/关闭预览将丢弃/)).toBeTruthy()

      fireEvent.click(screen.getByTestId('discard-cancel'))
      expect(closeFile).not.toHaveBeenCalled()
    })
  })

  // 未保存编辑的应用内导航防护：面板内换文件由 registerGuard 兜住，但点顶栏
  // 设置/项目看板、切换项目、浏览器后退这些路径会卸载整个 ChatPage，CodeMirror
  // 文档连同撤销历史一起消失——此前没有任何提示，用户只能重打一遍。
  describe('未保存编辑时应用内导航', () => {
    // TypedLink 是按 to 判别的联合，params 类型随路径收窄——常量各自固定一条路径。
    const TO_SETTINGS = (
      <TypedLink<AppPaths>
        to="/projects/:projectId/settings"
        params={{ projectId: 'p1' }}
        data-testid="to-settings"
      >
        设置
      </TypedLink>
    )
    const TO_DRAFT = (
      <TypedLink<AppPaths>
        to="/projects/:projectId"
        params={{ projectId: 'p1' }}
        data-testid="to-draft"
      >
        新会话
      </TypedLink>
    )
    const TO_OTHER_PROJECT = (
      <TypedLink<AppPaths>
        to="/projects/:projectId"
        params={{ projectId: 'p2' }}
        data-testid="to-other"
      >
        换项目
      </TypedLink>
    )

    it('非脏态：导航直接放行，不弹确认', async () => {
      vi.stubGlobal('fetch', fetchMock('line1\nline2'))
      renderPreview(
        { selectedFile: 'notes.txt' },
        <>
          <FilePreview projectId="p1" path="notes.txt" />
          {TO_SETTINGS}
        </>,
      )
      await screen.findByTestId('code-editor')
      expect(screen.getByTestId('chat-route')).toBeTruthy()

      fireEvent.click(screen.getByTestId('to-settings'))

      expect(screen.queryByTestId('preview-nav-discard-dialog')).toBeNull()
      await waitFor(() => expect(screen.getByTestId('settings-route')).toBeTruthy())
    })

    it('脏编辑时点「设置」：弹放弃确认，导航未提交', async () => {
      vi.stubGlobal('fetch', fetchMock('line1\nline2'))
      renderPreview(
        { selectedFile: 'notes.txt' },
        <>
          <FilePreview projectId="p1" path="notes.txt" />
          {TO_SETTINGS}
        </>,
      )
      await screen.findByTestId('code-editor')

      fireEvent.click(screen.getByTestId('mock-dirty'))
      fireEvent.click(screen.getByTestId('to-settings'))

      await waitFor(() => expect(screen.getByTestId('preview-nav-discard-dialog')).toBeTruthy())
      expect(screen.getByText(/离开当前页面将丢弃这些修改/)).toBeTruthy()
      expect(screen.queryByTestId('settings-route')).toBeNull()
      expect(screen.getByTestId('chat-route')).toBeTruthy()
    })

    it('选择「留下」：弹窗关闭并留在原页', async () => {
      vi.stubGlobal('fetch', fetchMock('line1\nline2'))
      renderPreview(
        { selectedFile: 'notes.txt' },
        <>
          <FilePreview projectId="p1" path="notes.txt" />
          {TO_SETTINGS}
        </>,
      )
      await screen.findByTestId('code-editor')

      fireEvent.click(screen.getByTestId('mock-dirty'))
      fireEvent.click(screen.getByTestId('to-settings'))
      await waitFor(() => expect(screen.getByTestId('preview-nav-discard-dialog')).toBeTruthy())

      fireEvent.click(screen.getByTestId('preview-nav-stay'))
      expect(screen.queryByTestId('preview-nav-discard-dialog')).toBeNull()
      expect(screen.queryByTestId('settings-route')).toBeNull()
      expect(screen.getByTestId('chat-route')).toBeTruthy()
      expect(screen.getByTestId('preview-path').textContent).toBe('notes.txt')
    })

    it('选择「离开」：重放被拦下的导航', async () => {
      vi.stubGlobal('fetch', fetchMock('line1\nline2'))
      renderPreview(
        { selectedFile: 'notes.txt' },
        <>
          <FilePreview projectId="p1" path="notes.txt" />
          {TO_SETTINGS}
        </>,
      )
      await screen.findByTestId('code-editor')

      fireEvent.click(screen.getByTestId('mock-dirty'))
      fireEvent.click(screen.getByTestId('to-settings'))
      await waitFor(() => expect(screen.getByTestId('preview-nav-discard-dialog')).toBeTruthy())

      fireEvent.click(screen.getByTestId('preview-nav-leave'))
      await waitFor(() => expect(screen.getByTestId('settings-route')).toBeTruthy())
    })

    it('同一项目的会话切换不弹确认（ChatPage 不卸载，编辑原样保留）', async () => {
      vi.stubGlobal('fetch', fetchMock('line1\nline2'))
      renderPreview(
        { selectedFile: 'notes.txt' },
        <>
          <FilePreview projectId="p1" path="notes.txt" />
          {TO_DRAFT}
        </>,
        ENTRY_SESSION,
      )
      await screen.findByTestId('code-editor')
      expect(screen.getByTestId('session-route')).toBeTruthy()

      fireEvent.click(screen.getByTestId('mock-dirty'))
      fireEvent.click(screen.getByTestId('to-draft'))

      expect(screen.queryByTestId('preview-nav-discard-dialog')).toBeNull()
      await waitFor(() => expect(screen.getByTestId('chat-route')).toBeTruthy())
      expect(screen.getByTestId('preview-path').textContent).toBe('notes.txt')
    })

    it('切到另一个项目会拦下（面板随项目重建，改动会丢）', async () => {
      vi.stubGlobal('fetch', fetchMock('line1\nline2'))
      renderPreview(
        { selectedFile: 'notes.txt' },
        <>
          <FilePreview projectId="p1" path="notes.txt" />
          {TO_OTHER_PROJECT}
        </>,
        ENTRY_SESSION,
      )
      await screen.findByTestId('code-editor')

      fireEvent.click(screen.getByTestId('mock-dirty'))
      fireEvent.click(screen.getByTestId('to-other'))

      expect(screen.getByTestId('preview-nav-discard-dialog')).toBeTruthy()
    })
  })

  it('选中文本后点击引用按钮调用 insertSnippetReference', async () => {
    const insertSnippetReference = vi.fn()
    const insertFileReference = vi.fn()
    vi.stubGlobal('fetch', fetchMock('hello world\nsecond line'))
    renderPreview(
      { selectedFile: 'notes.txt' },
      <ThemeProvider>
        <ReferenceContext.Provider
          value={{
            api: {
              insertFileReference,
              insertSnippetReference,
              insertTerminalReference: vi.fn(),
            },
            setApi: () => {},
          }}
        >
          <FilePreview projectId="p1" path="notes.txt" />
        </ReferenceContext.Provider>
      </ThemeProvider>,
    )
    // 等待内容渲染
    await waitFor(() => {
      expect(screen.getByTestId('preview-path').textContent).toBe('notes.txt')
    })
    // 找到内容区元素作为选区的公共祖先
    const scrollArea = screen.getByTestId('preview-content')
    // 模拟 window.getSelection 返回选中文本
    const mockRange = {
      getBoundingClientRect: () => ({ left: 10, top: 10, width: 50 }),
      commonAncestorContainer: scrollArea,
    }
    vi.stubGlobal('getSelection', () => ({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'hello world',
      getRangeAt: () => mockRange,
      removeAllRanges: () => {},
    }))
    // 触发 mouseup 检测选区
    fireEvent.mouseUp(scrollArea)
    // 引用按钮变为可见
    await waitFor(() => {
      expect(screen.getByTestId('quote-selection')).toBeVisible()
    })
    fireEvent.click(screen.getByTestId('quote-selection'))
    // 行号由全文回退计算：'hello world' 在第 1 行
    expect(insertSnippetReference).toHaveBeenCalledWith('notes.txt', 1, 1, 'hello world')
  })

  it('selectionchange 事件也能触发引用按钮（覆盖键盘选择场景）', async () => {
    const insertSnippetReference = vi.fn()
    const insertFileReference = vi.fn()
    vi.stubGlobal('fetch', fetchMock('hello world\nsecond line'))
    renderPreview(
      { selectedFile: 'notes.txt' },
      <ThemeProvider>
        <ReferenceContext.Provider
          value={{
            api: {
              insertFileReference,
              insertSnippetReference,
              insertTerminalReference: vi.fn(),
            },
            setApi: () => {},
          }}
        >
          <FilePreview projectId="p1" path="notes.txt" />
        </ReferenceContext.Provider>
      </ThemeProvider>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('preview-path').textContent).toBe('notes.txt')
    })
    const scrollArea = screen.getByTestId('preview-content')
    const mockRange = {
      getBoundingClientRect: () => ({ left: 10, top: 10, width: 50 }),
      commonAncestorContainer: scrollArea,
    }
    vi.stubGlobal('getSelection', () => ({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => 'hello world',
      getRangeAt: () => mockRange,
      removeAllRanges: () => {},
    }))
    // 仅 dispatch selectionchange，不触发 mouseup——模拟键盘选择（Ctrl+A 等）
    document.dispatchEvent(new Event('selectionchange'))
    await waitFor(() => {
      expect(screen.getByTestId('quote-selection')).toBeVisible()
    })
    fireEvent.click(screen.getByTestId('quote-selection'))
    expect(insertSnippetReference).toHaveBeenCalledWith('notes.txt', 1, 1, 'hello world')
  })

  // 复现：引用行号此前取 `.cm-line` 在 DOM 中的下标——CodeMirror 只渲染视口内的行
  // （其余行由 .cm-gap 占位），编辑器滚到文件中段时 DOM 里第一条渲染行已不是第 1 行，
  // 下标即「可见区第几行」：选中第 915 行引用出的却是 1-2 行，LLM 与点击跳转都拿到
  // 错误位置。（happy-dom 无布局，用 content 元素的可视矩形模拟「已滚动」。）
  it('编辑器已滚动（DOM 只含视口内行）时，引用行号按文档行号计算', async () => {
    const doc = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const origRect = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.classList?.contains('cm-content')) {
        return {
          top: -5000,
          bottom: 300,
          left: 0,
          right: 800,
          width: 800,
          height: 5300,
          x: 0,
          y: -5000,
          toJSON: () => {},
        } as DOMRect
      }
      return origRect.call(this)
    })
    const view = new EditorView({ state: EditorState.create({ doc }), parent: host })
    view.requestMeasure()
    await new Promise((resolve) => setTimeout(resolve, 50))
    // 前置断言：渲染出的行只是文档子集（视口从中段开始，前置行整体缺失）——
    // 否则本用例测不到「DOM 下标 ≠ 文档行号」。
    const renderedTexts = Array.from(host.querySelectorAll('.cm-line')).map(
      (el) => el.textContent ?? '',
    )
    expect(renderedTexts).toContain('line 915')
    expect(renderedTexts).not.toContain('line 500')
    expect(renderedTexts.length).toBeLessThan(200)

    const target = Array.from(host.querySelectorAll('.cm-line')).find(
      (el) => el.textContent === 'line 915',
    )
    expect(target).toBeTruthy()
    const textNode = target?.firstChild as Text
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, textNode.length)

    expect(computeLineRange(host, range, doc, 'line 915')).toEqual({ start: 915, end: 915 })
    view.destroy()
  })
})
