// PathPicker 组件测试，对应 src/web/components/PathPicker.tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PathPicker } from './PathPicker.js'

vi.mock('../services/filesystem.js', () => ({
  filesystemAPI: {
    browse: vi.fn(),
    home: vi.fn(),
  },
}))

const { filesystemAPI } = await import('../services/filesystem.js')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PathPicker', () => {
  it('输入路径后显示目录建议', async () => {
    vi.mocked(filesystemAPI.browse).mockResolvedValue({
      path: '/home/user',
      directories: [
        { name: 'projects', path: '/home/user/projects' },
        { name: 'docs', path: '/home/user/docs' },
      ],
    })

    vi.useRealTimers()
    render(<PathPicker value="/home/user/" onChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('projects/')).toBeTruthy()
      expect(screen.getByText('docs/')).toBeTruthy()
    })
  })

  it('输入前缀过滤建议', async () => {
    vi.mocked(filesystemAPI.browse).mockResolvedValue({
      path: '/home/user',
      directories: [
        { name: 'projects', path: '/home/user/projects' },
        { name: 'docs', path: '/home/user/docs' },
      ],
    })

    vi.useRealTimers()
    render(<PathPicker value="/home/user/pro" onChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('projects/')).toBeTruthy()
      expect(screen.queryByText('docs/')).toBeNull()
    })
  })

  it('点击建议追加路径', async () => {
    const onChange = vi.fn()
    vi.mocked(filesystemAPI.browse).mockResolvedValue({
      path: '/home/user',
      directories: [{ name: 'projects', path: '/home/user/projects' }],
    })

    vi.useRealTimers()
    render(<PathPicker value="/home/user/" onChange={onChange} />)

    await waitFor(() => {
      expect(screen.getByText('projects/')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('suggestion-0'))
    expect(onChange).toHaveBeenCalledWith('/home/user/projects/')
  })

  it('空路径不显示建议', () => {
    vi.useRealTimers()
    render(<PathPicker value="" onChange={vi.fn()} />)
    expect(screen.queryByTestId('path-picker-suggestions')).toBeNull()
  })

  it('加载失败显示无匹配', async () => {
    vi.mocked(filesystemAPI.browse).mockRejectedValue(new Error('network'))
    vi.useRealTimers()
    render(<PathPicker value="/bad/" onChange={vi.fn()} />)

    await waitFor(() => {
      expect(screen.queryByTestId('path-picker-suggestions')).toBeNull()
    })
  })

  it('使用自定义 testId', () => {
    vi.useRealTimers()
    render(<PathPicker value="" onChange={vi.fn()} testId="custom-picker" />)
    expect(screen.getByTestId('custom-picker')).toBeTruthy()
  })
})
