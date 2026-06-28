// DirectoryPicker 组件测试，对应 src/web/components/DirectoryPicker.tsx
// 归并建议：DirectoryPicker 为核心选择器组件，独立测试其搜索/导航/选择交互。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryPicker } from './DirectoryPicker.js'

vi.mock('../services/filesystem.js', () => ({
  filesystemAPI: {
    browse: vi.fn(),
    home: vi.fn(),
    search: vi.fn(),
  },
}))

const { filesystemAPI } = await import('../services/filesystem.js')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(filesystemAPI.home).mockResolvedValue({ path: '/home/user' })
  vi.mocked(filesystemAPI.browse).mockResolvedValue({ path: '/home/user', directories: [] })
  vi.mocked(filesystemAPI.search).mockResolvedValue({ items: [] })
})

afterEach(() => {
  cleanup()
})

/** 受控包装：fireEvent.change 后回写 value，驱动输入→搜索。 */
function Controlled({
  initial = '',
  onChange,
}: {
  initial?: string
  onChange?: (v: string) => void
}) {
  const [v, setV] = useState(initial)
  return (
    <DirectoryPicker
      value={v}
      onChange={(next) => {
        setV(next)
        onChange?.(next)
      }}
    />
  )
}

describe('DirectoryPicker', () => {
  it('挂载后自动导航到 home 并加载文件树', async () => {
    vi.mocked(filesystemAPI.browse).mockResolvedValue({
      path: '/home/user',
      directories: [
        { name: 'projects', path: '/home/user/projects' },
        { name: 'docs', path: '/home/user/docs' },
      ],
    })
    render(<DirectoryPicker value="" onChange={vi.fn()} />)
    await waitFor(() => {
      expect(filesystemAPI.browse).toHaveBeenCalledWith('/home/user')
    })
    await waitFor(() => {
      expect(screen.getByText('user')).toBeTruthy()
    })
  })

  it('纯名字输入触发递归搜索并显示建议', async () => {
    vi.mocked(filesystemAPI.search).mockResolvedValue({ items: ['projects/c0de-agent'] })
    render(<Controlled />)
    await waitFor(() => expect(filesystemAPI.home).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('user')).toBeTruthy())

    const input = screen.getByTestId('directory-picker-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'c0de' } })

    await waitFor(() => {
      expect(filesystemAPI.search).toHaveBeenCalledWith('/home/user', 'c0de', 50)
    })
    await waitFor(() => {
      expect(screen.getByText(/c0de-agent/)).toBeTruthy()
    })
  })

  it('点击目录建议触发导航（加载该目录到树）', async () => {
    vi.mocked(filesystemAPI.search).mockResolvedValue({ items: ['projects'] })
    let browseCalls = 0
    vi.mocked(filesystemAPI.browse).mockImplementation(async (path: string) => {
      browseCalls++
      if (path === '/home/user') return { path, directories: [] }
      return { path, directories: [{ name: 'c0de-agent', path: `${path}/c0de-agent` }] }
    })
    render(<Controlled />)
    await waitFor(() => expect(filesystemAPI.home).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('user')).toBeTruthy())

    const input = screen.getByTestId('directory-picker-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'pro' } })
    await waitFor(() => expect(screen.queryByTestId('suggestion-0')).toBeTruthy())

    fireEvent.click(screen.getByTestId('suggestion-0'))
    // navigate 到建议目录 → browse 该目录
    await waitFor(() => {
      expect(browseCalls).toBeGreaterThan(1)
    })
  })

  it('选择文件树节点同步 onChange + 选中栏', async () => {
    vi.mocked(filesystemAPI.browse).mockResolvedValue({
      path: '/home/user',
      directories: [{ name: 'projects', path: '/home/user/projects' }],
    })
    const onChange = vi.fn()
    render(<DirectoryPicker value="" onChange={onChange} />)
    await waitFor(() => expect(filesystemAPI.browse).toHaveBeenCalledWith('/home/user'))
    await waitFor(() => expect(screen.getByText('user')).toBeTruthy())

    fireEvent.click(screen.getByTestId('toggle-/home/user'))
    await waitFor(() => expect(screen.getByText('projects')).toBeTruthy())

    fireEvent.click(screen.getByTestId('node-/home/user/projects'))
    expect(onChange).toHaveBeenCalledWith('/home/user/projects')
    await waitFor(() => {
      expect(screen.getByTestId('directory-picker-selection').textContent).toBe(
        '/home/user/projects',
      )
    })
  })

  it('home/根/父 按钮触发导航', async () => {
    vi.mocked(filesystemAPI.browse).mockResolvedValue({
      path: '/home/user',
      directories: [],
    })
    render(<DirectoryPicker value="" onChange={vi.fn()} start="/home/user/projects" />)
    await waitFor(() => expect(filesystemAPI.browse).toHaveBeenCalledWith('/home/user/projects'))

    fireEvent.click(screen.getByLabelText('父目录'))
    await waitFor(() => expect(filesystemAPI.browse).toHaveBeenCalledWith('/home/user'))
    fireEvent.click(screen.getByLabelText('根目录'))
    await waitFor(() => expect(filesystemAPI.browse).toHaveBeenCalledWith('/'))
  })

  it('导航失败显示错误态', async () => {
    vi.mocked(filesystemAPI.browse).mockRejectedValue(new Error('denied'))
    render(<DirectoryPicker value="" onChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('读取失败')).toBeTruthy())
  })

  it('ArrowDown/Up 移动建议索引', async () => {
    vi.mocked(filesystemAPI.search).mockResolvedValue({ items: ['a', 'b'] })
    render(<Controlled />)
    await waitFor(() => expect(filesystemAPI.home).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('user')).toBeTruthy())

    const input = screen.getByTestId('directory-picker-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'x' } })
    await waitFor(() => expect(screen.queryByTestId('suggestion-0')).toBeTruthy())

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByTestId('suggestion-0').getAttribute('data-active')).not.toBeNull()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByTestId('suggestion-1').getAttribute('data-active')).not.toBeNull()
  })

  it('受控 value 透传到输入框', async () => {
    render(<DirectoryPicker value="/custom/path" onChange={vi.fn()} />)
    const input = screen.getByTestId('directory-picker-input') as HTMLInputElement
    expect(input.value).toBe('/custom/path')
  })
})
