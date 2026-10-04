// AddProjectDialog 组件测试，对应 src/web/components/AddProjectDialog.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddProjectDialog } from '@/components/AddProjectDialog.js'
import { projectAPI } from '@/services/project.js'

vi.mock('@/services/project.js', () => ({
  projectAPI: {
    fromDirectory: vi.fn(),
    list: vi.fn(),
    current: vi.fn(),
    get: vi.fn(),
    updateName: vi.fn(),
  },
}))

// DirectoryPicker 依赖 filesystem service，mock 掉避免测试中发起网络请求
vi.mock('../services/filesystem.js', () => ({
  filesystemAPI: {
    browse: vi.fn().mockResolvedValue({ path: '', directories: [] }),
    home: vi.fn().mockResolvedValue({ path: '' }),
    search: vi.fn().mockResolvedValue({ items: [] }),
  },
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient()
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('AddProjectDialog', () => {
  it('空目录时确认按钮禁用', () => {
    renderWithClient(<AddProjectDialog onClose={vi.fn()} />)
    expect(screen.getByTestId('add-project-confirm')).toBeTruthy()
    expect((screen.getByTestId('add-project-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('输入目录并确认，调用 fromDirectory 并回调', async () => {
    const onClose = vi.fn()
    const onCreated = vi.fn()
    const project = { id: 'p1', name: 'demo' }
    const mocked = vi.mocked(projectAPI.fromDirectory).mockResolvedValue(project as never)
    renderWithClient(<AddProjectDialog onClose={onClose} onCreated={onCreated} />)

    fireEvent.change(screen.getByTestId('add-project-input'), { target: { value: '/tmp/demo' } })
    fireEvent.click(screen.getByTestId('add-project-confirm'))

    await waitFor(() => {
      expect(mocked).toHaveBeenCalledWith('/tmp/demo')
      expect(onCreated).toHaveBeenCalledWith(project)
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('fromDirectory 失败时显示错误且不关闭', async () => {
    const onClose = vi.fn()
    vi.mocked(projectAPI.fromDirectory).mockRejectedValue(new Error('目录不存在'))
    renderWithClient(<AddProjectDialog onClose={onClose} />)

    fireEvent.change(screen.getByTestId('add-project-input'), { target: { value: '/bad' } })
    fireEvent.click(screen.getByTestId('add-project-confirm'))

    await waitFor(() => {
      expect(screen.getByText('目录不存在')).toBeTruthy()
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('点取消关闭弹窗', () => {
    const onClose = vi.fn()
    renderWithClient(<AddProjectDialog onClose={onClose} />)
    fireEvent.click(screen.getByText('取消'))
    expect(onClose).toHaveBeenCalled()
  })

  // Escape / 遮罩点击的关闭语义由原生 <dialog>（Dialog 原语）提供，jsdom 不
  // 实现 showModal，故此处无法在 jsdom 内断言。真实浏览器中的等价验证见提交说明：
  // 弹层为原生 dialog，Esc 与 ::backdrop 点击均由浏览器触发 onClose。
  it('弹层为原生 <dialog>（Esc / 遮罩点击由浏览器处理）', () => {
    const { container } = renderWithClient(<AddProjectDialog onClose={vi.fn()} />)
    expect(container.querySelector('dialog')).toBeTruthy()
  })

  it('回车提交（宿主 onKeyDown 的未消费键透传）', async () => {
    const onClose = vi.fn()
    const mocked = vi.mocked(projectAPI.fromDirectory).mockResolvedValue({
      id: 'p1',
      name: 'demo',
    } as never)
    renderWithClient(<AddProjectDialog onClose={onClose} />)

    fireEvent.change(screen.getByTestId('add-project-input'), { target: { value: '/tmp/demo' } })
    fireEvent.keyDown(screen.getByTestId('add-project-input'), { key: 'Enter' })

    await waitFor(() => expect(mocked).toHaveBeenCalledWith('/tmp/demo'))
    expect(onClose).toHaveBeenCalled()
  })
})
