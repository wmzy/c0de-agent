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

  // 复现：首次自动导航到 home 也会 onChange('~')，把「当前浏览位置」当成
  // 「用户的选中值」回填给宿主。没有任何选择的宿主（AddProjectDialog）因此
  // value 非空、确认按钮即刻可用——打开弹窗什么都不选，回车即把 $HOME 注册成项目。
  it('首次自动导航到 home 不回填宿主值（浏览 ≠ 选择）', async () => {
    const onChange = vi.fn()
    render(<DirectoryPicker value="" onChange={onChange} />)
    await waitFor(() => expect(filesystemAPI.browse).toHaveBeenCalledWith('/home/user'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('用户主动导航（~ 按钮）仍回填宿主值', async () => {
    const onChange = vi.fn()
    render(<DirectoryPicker value="" onChange={onChange} start="/tmp" />)
    await waitFor(() => expect(filesystemAPI.browse).toHaveBeenCalledWith('/tmp'))

    fireEvent.click(screen.getByLabelText('home'))
    // home 显示为 `~`（在 home 下的路径一律 tilde 化）
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('~'))
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

  // 回归：失败态此前只有一个「读取失败」字样（无原因、无自救入口）；
  // 子目录加载失败更糟——被 catch 落成 children: []，渲染成「（空）」，
  // 把「读不到」说成了「没有」。
  it('导航失败展示后端原因并可重试', async () => {
    vi.mocked(filesystemAPI.browse).mockRejectedValue(
      Object.assign(new Error('没有权限读取该目录：/home/user'), {
        message: '没有权限读取该目录：/home/user',
      }),
    )
    render(<DirectoryPicker value="" onChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('directory-picker-error')).toBeTruthy())
    expect(screen.getByTestId('directory-picker-error').textContent).toContain('没有权限读取该目录')
    expect(screen.queryByText('读取失败')).toBeNull()

    const callsBefore = vi.mocked(filesystemAPI.browse).mock.calls.length
    vi.mocked(filesystemAPI.browse).mockResolvedValue({ path: '/home/user', directories: [] })
    fireEvent.click(screen.getByTestId('directory-picker-retry'))
    await waitFor(() =>
      expect(vi.mocked(filesystemAPI.browse).mock.calls.length).toBeGreaterThan(callsBefore),
    )
    await waitFor(() => expect(screen.queryByTestId('directory-picker-error')).toBeNull())
  })

  // 回归（审查 #4）：重试失败的初始加载仍是「浏览 ≠ 选择」——重试按钮曾不带
  // { silent: true }，导航成功即 onChange 回填宿主值，等于重新武装了首航 silent
  // 修掉的问题（打开添加项目对话框 → 加载失败 → 重试 → 回车注册 $HOME）。
  it('初始加载失败后重试成功：不回填宿主值（重试与首航同为 silent）', async () => {
    vi.mocked(filesystemAPI.browse).mockRejectedValueOnce(new Error('暂时读不到'))
    const onChange = vi.fn()
    render(<DirectoryPicker value="" onChange={onChange} />)
    await waitFor(() => expect(screen.getByTestId('directory-picker-error')).toBeTruthy())

    // 后端恢复：重试后导航成功（错误态消失）
    fireEvent.click(screen.getByTestId('directory-picker-retry'))
    await waitFor(() => expect(screen.queryByTestId('directory-picker-error')).toBeNull())

    // 全程无任何选择 → 宿主值不被回填
    expect(onChange).not.toHaveBeenCalled()
  })

  it('子目录加载失败展示原因与重试，而不是「（空）」', async () => {
    vi.mocked(filesystemAPI.browse).mockResolvedValue({
      path: '/home/user',
      directories: [{ name: 'locked', path: '/home/user/locked' }],
    })
    render(<DirectoryPicker value="" onChange={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('toggle-/home/user')).toBeTruthy())
    // 根展开后子目录才渲染（子节点懒渲染），再点子目录触发懒加载失败
    fireEvent.click(screen.getByTestId('toggle-/home/user'))
    await waitFor(() => expect(screen.getByTestId('toggle-/home/user/locked')).toBeTruthy())

    vi.mocked(filesystemAPI.browse).mockRejectedValue(
      Object.assign(new Error('x'), { message: '没有权限读取该目录：/home/user/locked' }),
    )
    fireEvent.click(screen.getByTestId('toggle-/home/user/locked'))
    await waitFor(() =>
      expect(screen.getByTestId('load-error-/home/user/locked').textContent).toContain(
        '没有权限读取该目录',
      ),
    )
    expect(screen.queryByText('（空）')).toBeNull()

    vi.mocked(filesystemAPI.browse).mockResolvedValue({
      path: '/home/user/locked',
      directories: [{ name: 'inner', path: '/home/user/locked/inner' }],
    })
    fireEvent.click(screen.getByTestId('load-retry-/home/user/locked'))
    await waitFor(() => expect(screen.queryByTestId('load-error-/home/user/locked')).toBeNull())
    expect(screen.getByTestId('toggle-/home/user/locked/inner')).toBeTruthy()
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
