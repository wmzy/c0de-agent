// DirectoryPicker 组件测试，对应 src/web/components/DirectoryPicker.tsx
// 归并建议：DirectoryPicker 为核心选择器组件，独立测试其搜索/导航/选择交互。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type KeyboardEvent as ReactKeyboardEvent, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryPicker } from '@/components/DirectoryPicker.js'

vi.mock('@/services/filesystem.js', () => ({
  filesystemAPI: {
    browse: vi.fn(),
    home: vi.fn(),
    search: vi.fn(),
  },
}))

const { filesystemAPI } = await import('@/services/filesystem.js')

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
  onKeyDown,
}: {
  initial?: string
  onChange?: (v: string) => void
  onKeyDown?: (e: ReactKeyboardEvent) => void
}) {
  const [v, setV] = useState(initial)
  return (
    <DirectoryPicker
      value={v}
      onChange={(next) => {
        setV(next)
        onChange?.(next)
      }}
      {...(onKeyDown ? { onKeyDown } : {})}
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

  // 复现：输入框的 Enter/Escape/方向键处理不看 IME 组合态。中文/日文输入法用
  // 回车确认候选词时会派发 keydown（isComposing=true，keyCode 229）——未拦截即
  // 把未确认的候选当成最终输入：目录名输入到一半（如「/home/zlt/项」）按回车
  // 确认候选，却被当作「选择建议/按输入导航」处理，直接跳到错误目录。
  it('IME 组合中的回车不选建议、不导航（中文输入法确认候选）', async () => {
    vi.mocked(filesystemAPI.search).mockResolvedValue({ items: ['projects'] })
    let browseCalls = 0
    vi.mocked(filesystemAPI.browse).mockImplementation(async (path: string) => {
      browseCalls++
      return { path, directories: [] }
    })
    render(<Controlled />)
    await waitFor(() => expect(filesystemAPI.home).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('user')).toBeTruthy())
    const input = screen.getByTestId('directory-picker-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '项' } })
    await waitFor(() => expect(screen.queryByTestId('suggestion-0')).toBeTruthy())
    const browseBefore = browseCalls

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(browseCalls).toBe(browseBefore) // 未被当成「按输入导航」
    expect(screen.queryByTestId('suggestion-0')).toBeTruthy() // 未选择建议，列表仍在
  })

  // 复现：Escape/Enter 被无条件消费（Escape 分支恒 return、Enter 分支恒
  // navigate + return），onKeyDown 契约的「未处理键透传」从不生效。宿主
  // （AddProjectDialog/RelocateProjectDialog）在 onKeyDown 里写的 Escape 关闭
  // 对话框 / Enter 提交表单是死代码——用户按 Esc 关不掉对话框、按回车提交不了。
  it('未消费的 Escape 透传给宿主（建议列表未打开）', async () => {
    const onKeyDown = vi.fn()
    render(<DirectoryPicker value="" onChange={vi.fn()} onKeyDown={onKeyDown} />)
    await waitFor(() => expect(filesystemAPI.home).toHaveBeenCalled())
    const input = screen.getByTestId('directory-picker-input') as HTMLInputElement

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onKeyDown).toHaveBeenCalledTimes(1)
    expect(onKeyDown.mock.calls[0]?.[0]?.key).toBe('Escape')
  })

  it('建议列表打开时 Escape 只关建议、不透传（层级消费）', async () => {
    vi.mocked(filesystemAPI.search).mockResolvedValue({ items: ['projects'] })
    const onKeyDown = vi.fn()
    render(<Controlled onKeyDown={onKeyDown} />)
    await waitFor(() => expect(filesystemAPI.home).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('user')).toBeTruthy())
    const input = screen.getByTestId('directory-picker-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'pro' } })
    await waitFor(() => expect(screen.queryByTestId('suggestion-0')).toBeTruthy())

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onKeyDown).not.toHaveBeenCalled()
    expect(screen.queryByTestId('suggestion-0')).toBeNull()
  })

  it('无建议可消费时 Enter 透传给宿主（表单提交）', async () => {
    const onKeyDown = vi.fn()
    render(<DirectoryPicker value="" onChange={vi.fn()} onKeyDown={onKeyDown} />)
    await waitFor(() => expect(filesystemAPI.home).toHaveBeenCalled())
    const input = screen.getByTestId('directory-picker-input') as HTMLInputElement

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onKeyDown).toHaveBeenCalledTimes(1)
    expect(onKeyDown.mock.calls[0]?.[0]?.key).toBe('Enter')
  })

  it('建议列表打开时 Enter 选建议、不透传', async () => {
    vi.mocked(filesystemAPI.search).mockResolvedValue({ items: ['projects'] })
    const onKeyDown = vi.fn()
    let browseCalls = 0
    vi.mocked(filesystemAPI.browse).mockImplementation(async (path: string) => {
      browseCalls++
      return { path, directories: [] }
    })
    render(<Controlled onKeyDown={onKeyDown} />)
    await waitFor(() => expect(filesystemAPI.home).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('user')).toBeTruthy())
    const input = screen.getByTestId('directory-picker-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'pro' } })
    await waitFor(() => expect(screen.queryByTestId('suggestion-0')).toBeTruthy())
    const browseBefore = browseCalls

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onKeyDown).not.toHaveBeenCalled()
    await waitFor(() => expect(browseCalls).toBeGreaterThan(browseBefore)) // 导航到建议目录
  })
})
