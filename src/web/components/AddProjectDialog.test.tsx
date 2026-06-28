// AddProjectDialog 组件测试，对应 src/web/components/AddProjectDialog.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectAPI } from '../services/project.js'
import { AddProjectDialog } from './AddProjectDialog.js'

vi.mock('../services/project.js', () => ({
  projectAPI: {
    fromDirectory: vi.fn(),
    list: vi.fn(),
    current: vi.fn(),
    get: vi.fn(),
    updateName: vi.fn(),
  },
}))

// PathPicker 依赖 filesystem service，mock 掉避免测试中发起网络请求
vi.mock('../services/filesystem.js', () => ({
  filesystemAPI: {
    browse: vi.fn().mockResolvedValue({ path: '', directories: [] }),
    home: vi.fn(),
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
})
