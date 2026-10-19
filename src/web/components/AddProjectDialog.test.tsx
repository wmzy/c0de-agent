// AddProjectDialog 组件测试，对应 src/web/components/AddProjectDialog.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddProjectDialog } from '@/components/AddProjectDialog.js'
import { filesystemAPI } from '@/services/filesystem.js'
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

  // 复现：DirectoryPicker 首次自动导航到 home 时把 `~` 回填成宿主 value，
  // 「添加」的启用条件（value 非空）随即成立——用户只打开弹窗、什么都没选，
  // 回车/点击即把 $HOME 注册成项目。
  it('未做任何选择时确认按钮保持禁用（home 自动导航不回填）', async () => {
    vi.mocked(filesystemAPI.home).mockResolvedValue({ path: '/home/user' })
    vi.mocked(filesystemAPI.browse).mockResolvedValue({ path: '/home/user', directories: [] })
    renderWithClient(<AddProjectDialog onClose={vi.fn()} />)

    await waitFor(() => expect(filesystemAPI.browse).toHaveBeenCalledWith('/home/user'))
    const input = screen.getByTestId('add-project-input') as HTMLInputElement
    expect(input.value).toBe('')
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
    // 失败原因只存在于这块面板里，必须被读屏播报出来。
    expect(screen.getByRole('alert').textContent).toContain('目录不存在')
  })

  // 复现：请求在飞时按 Esc / 点取消 → 面板立即卸载，服务端随后 500，
  // setError 写进已卸载的组件——项目没建出来，用户零反馈。
  it('创建在飞时关不掉弹窗，失败原因不会随卸载消失', async () => {
    const onClose = vi.fn()
    let reject!: (e: unknown) => void
    vi.mocked(projectAPI.fromDirectory).mockReturnValue(
      new Promise((_res, rej) => {
        reject = rej
      }) as never,
    )
    renderWithClient(<AddProjectDialog onClose={onClose} />)

    fireEvent.change(screen.getByTestId('add-project-input'), { target: { value: '/slow' } })
    fireEvent.click(screen.getByTestId('add-project-confirm'))

    await waitFor(() =>
      expect((screen.getByTestId('add-project-confirm') as HTMLButtonElement).disabled).toBe(true),
    )
    // 取消键在在飞期间不可点，点了也不会关。
    expect((screen.getByText('取消') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('取消'))
    expect(onClose).not.toHaveBeenCalled()

    reject(new Error('目录已被占用'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('目录已被占用'))
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
