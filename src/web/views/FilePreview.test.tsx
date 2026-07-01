import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSelectionContext } from '../contexts/FileSelectionContext.js'
import { FilePreview } from './FilePreview.js'

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
    withClient(<FilePreview path="a.md" />)
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
    withClient(<FilePreview path="song.mp3" />)
    const audio = document.querySelector('audio')
    expect(audio).toBeTruthy()
    expect(audio?.getAttribute('src')).toContain('/api/files/song.mp3/raw')
  })

  it('渲染视频文件为内联播放器', async () => {
    withClient(<FilePreview path="clip.mp4" />)
    const video = document.querySelector('video')
    expect(video).toBeTruthy()
    expect(video?.getAttribute('src')).toContain('/api/files/clip.mp4/raw')
  })

  it('图片 src 指向 /raw 端点', async () => {
    withClient(<FilePreview path="a.png" />)
    const img = document.querySelector('img')
    expect(img).toBeTruthy()
    expect(img?.getAttribute('src')).toContain('/api/files/a.png/raw')
  })

  it('渲染 header 显示路径', async () => {
    vi.stubGlobal('fetch', fetchMock('# Title'))
    withClient(<FilePreview path="readme.md" />)
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
          <FilePreview path="readme.md" />
        </FileSelectionContext.Provider>
      </QueryClientProvider>,
    )
    await waitFor(() => {
      expect(screen.getByLabelText('关闭预览')).toBeTruthy()
    })
    fireEvent.click(screen.getByLabelText('关闭预览'))
    expect(closeFile).toHaveBeenCalledOnce()
  })
})
