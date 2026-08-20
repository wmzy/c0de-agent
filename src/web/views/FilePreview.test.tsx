import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSelectionContext } from '../contexts/FileSelectionContext.js'
import { ReferenceContext } from '../contexts/ReferenceContext.js'
import { ThemeProvider } from '../contexts/ThemeContext.js'
import { FilePreview } from './FilePreview.js'

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
  })
}

function withClient(ui: React.ReactNode, closeFile = () => {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <FileSelectionContext.Provider value={{ selectedFile: null, openFile: () => {}, closeFile }}>
        {ui}
      </FileSelectionContext.Provider>
    </QueryClientProvider>,
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
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <FileSelectionContext.Provider
          value={{ selectedFile: 'readme.md', openFile: () => {}, closeFile }}
        >
          <FilePreview projectId="p1" path="readme.md" />
        </FileSelectionContext.Provider>
      </QueryClientProvider>,
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
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <FileSelectionContext.Provider
          value={{ selectedFile: 'notes.txt', openFile: () => {}, closeFile }}
        >
          <FilePreview projectId="p1" path="notes.txt" />
        </FileSelectionContext.Provider>
      </QueryClientProvider>,
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
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <FileSelectionContext.Provider
          value={{ selectedFile: 'notes.txt', openFile: () => {}, closeFile }}
        >
          <FilePreview projectId="p1" path="notes.txt" />
        </FileSelectionContext.Provider>
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('code-editor')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('mock-dirty'))
    fireEvent.click(screen.getByLabelText('关闭预览'))
    fireEvent.click(screen.getByTestId('discard-confirm'))
    expect(closeFile).toHaveBeenCalledOnce()
  })

  it('选中文本后点击引用按钮调用 insertSnippetReference', async () => {
    const insertSnippetReference = vi.fn()
    const insertFileReference = vi.fn()
    vi.stubGlobal('fetch', fetchMock('hello world\nsecond line'))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
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
            <FileSelectionContext.Provider
              value={{ selectedFile: 'notes.txt', openFile: () => {}, closeFile: () => {} }}
            >
              <FilePreview projectId="p1" path="notes.txt" />
            </FileSelectionContext.Provider>
          </ReferenceContext.Provider>
        </ThemeProvider>
      </QueryClientProvider>,
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
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
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
            <FileSelectionContext.Provider
              value={{ selectedFile: 'notes.txt', openFile: () => {}, closeFile: () => {} }}
            >
              <FilePreview projectId="p1" path="notes.txt" />
            </FileSelectionContext.Provider>
          </ReferenceContext.Provider>
        </ThemeProvider>
      </QueryClientProvider>,
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
})
