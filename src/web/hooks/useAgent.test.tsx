/**
 * useAgent 测试：控制端点（暂停/恢复/中止）的失败必须可见，且不得乐观翻转。
 *
 * 缺陷：run() 只有 try/finally，请求失败以未处理 rejection 结束、界面零反馈；
 * pause/resume 更无视服务端的 {paused:false}/{resumed:false}（无活跃 run 时
 * 服务端明确返回 false，见 POST /api/chat/pause 的路由用例）也置位 paused——
 * 按钮翻成「恢复」，而 run 从未停下，仍在消耗 token。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgent } from '@/hooks/useAgent.js'
import { agentAPI } from '@/services/agent.js'

vi.mock('@/services/agent.js', () => ({
  agentAPI: {
    abort: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    steer: vi.fn(),
    confirmTool: vi.fn(),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useAgent 暂停/恢复', () => {
  it('服务端回 {paused:false} 时不翻转暂停态，并给出原因', async () => {
    vi.mocked(agentAPI.pause).mockResolvedValue({ paused: false })
    const { result } = renderHook(() => useAgent('s1'))

    await act(async () => {
      await result.current.pause()
    })

    expect(result.current.paused).toBe(false)
    expect(result.current.error).toContain('没有可暂停的运行')
  })

  it('服务端回 {paused:true} 时才翻转暂停态', async () => {
    vi.mocked(agentAPI.pause).mockResolvedValue({ paused: true })
    const { result } = renderHook(() => useAgent('s1'))

    await act(async () => {
      await result.current.pause()
    })

    expect(result.current.paused).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('请求失败时原因可见且不抛未处理 rejection', async () => {
    vi.mocked(agentAPI.pause).mockRejectedValue(new Error('服务未启动'))
    const { result } = renderHook(() => useAgent('s1'))

    await act(async () => {
      await expect(result.current.pause()).resolves.toBeUndefined()
    })

    expect(result.current.error).toBe('服务未启动')
    expect(result.current.paused).toBe(false)
    expect(result.current.busy).toBe(false)
  })

  it('恢复失败时保持暂停态并给出原因', async () => {
    vi.mocked(agentAPI.pause).mockResolvedValue({ paused: true })
    vi.mocked(agentAPI.resume).mockResolvedValue({ resumed: false })
    const { result } = renderHook(() => useAgent('s1'))

    await act(async () => {
      await result.current.pause()
    })
    expect(result.current.paused).toBe(true)

    await act(async () => {
      await result.current.resume()
    })

    // 谎报「已恢复」会让用户以为对话在跑，其实它还停着
    expect(result.current.paused).toBe(true)
    expect(result.current.error).toContain('没有可恢复的运行')
  })

  it('下一次操作开始时清掉上一次的旧原因', async () => {
    vi.mocked(agentAPI.pause).mockRejectedValueOnce(new Error('服务未启动'))
    const { result } = renderHook(() => useAgent('s1'))

    await act(async () => {
      await result.current.pause()
    })
    expect(result.current.error).toBe('服务未启动')

    vi.mocked(agentAPI.pause).mockResolvedValue({ paused: true })
    await act(async () => {
      await result.current.pause()
    })
    expect(result.current.error).toBeNull()
  })
})
