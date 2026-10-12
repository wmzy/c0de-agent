// Shake 的失败路径必须留下痕迹：预览走空 catch、提交 mutation 没有 onError 时，
// 请求失败后界面与点击前完全一致（按钮零反应 / 抖动模式照旧），用户只能判定为
// 「按钮坏了」并反复点。此文件锁住「失败必须暴露原因」，以及成功/退出时清干净。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useShake } from '@/hooks/useShake.js'
import { sessionAPI } from '@/services/session.js'
import type { ShakeRegionView } from '@/types/index.js'

vi.mock('@/services/session.js', () => ({
  sessionAPI: { shakePreview: vi.fn(), shakeApply: vi.fn() },
}))

const region: ShakeRegionView = {
  id: 'r1',
  kind: 'toolResult',
  messageId: 'm1',
  messageIndex: 1,
  partIndex: 0,
  tokens: 42,
  label: 'tool_result',
  preview: '…',
  placeholder: '…',
  isAfterProtectWindow: true,
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(() => useShake('s1', [], qc), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  })
}

beforeEach(() => {
  vi.mocked(sessionAPI.shakePreview).mockReset()
  vi.mocked(sessionAPI.shakeApply).mockReset()
})

describe('useShake 失败反馈', () => {
  it('预览失败时给出原因且不进入 Shake 模式', async () => {
    vi.mocked(sessionAPI.shakePreview).mockRejectedValue(new Error('数据库被占用'))
    const { result } = setup()

    await act(async () => {
      await result.current.handleShakeOpen()
    })

    expect(result.current.shakeMode).toBe(false)
    expect(result.current.shakeError).toBe('数据库被占用')
  })

  it('预览失败后重试成功会清掉错误并打开 Shake', async () => {
    vi.mocked(sessionAPI.shakePreview).mockRejectedValueOnce(new Error('boom'))
    const { result } = setup()
    await act(async () => {
      await result.current.handleShakeOpen()
    })
    expect(result.current.shakeError).toBe('boom')

    vi.mocked(sessionAPI.shakePreview).mockResolvedValueOnce({ regions: [region] })
    await act(async () => {
      await result.current.handleShakeOpen()
    })

    expect(result.current.shakeError).toBeNull()
    expect(result.current.shakeMode).toBe(true)
    // 保护窗口内的区域默认不勾选，窗口外的默认勾选（既有行为不变）。
    expect(result.current.shakeSelected.has('r1')).toBe(true)
  })

  it('提交失败时保留抖动模式与选择，只把原因说出来', async () => {
    vi.mocked(sessionAPI.shakePreview).mockResolvedValue({ regions: [region] })
    vi.mocked(sessionAPI.shakeApply).mockRejectedValue({ message: '会话已归档' })
    const { result } = setup()
    await act(async () => {
      await result.current.handleShakeOpen()
    })

    act(() => {
      result.current.shakeMutation.mutate(['r1'])
    })

    await waitFor(() => expect(result.current.shakeError).toBe('会话已归档'))
    expect(result.current.shakeMode).toBe(true)
    expect(result.current.shakeSelected.has('r1')).toBe(true)
  })

  it('退出 Shake 模式会清掉上一次的失败原因', async () => {
    vi.mocked(sessionAPI.shakePreview).mockRejectedValue(new Error('boom'))
    const { result } = setup()
    await act(async () => {
      await result.current.handleShakeOpen()
    })
    expect(result.current.shakeError).toBe('boom')

    act(() => {
      result.current.exitShakeMode()
    })
    expect(result.current.shakeError).toBeNull()
  })
})
