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

  // 回归：resume() 的返回值是调用点（ChatSession 的三个「恢复」按钮）唯一的判据
  // ——它据此决定要不要撤下暂停横幅。请求抛错或服务端回 {resumed:false} 时 run 仍
  // 停在暂停点，撤掉横幅＝界面宣称「在跑」而实际不会继续，且唯一能恢复的入口
  // 一起消失（只能刷新页面重来，新消息还会撞 409）。
  it('resume() 把「是否真的恢复」回传给调用点（失败与未受理都回假）', async () => {
    const { result } = renderHook(() => useAgent('s1'))
    let ok: boolean | undefined

    vi.mocked(agentAPI.resume).mockRejectedValue(new Error('服务未启动'))
    await act(async () => {
      ok = await result.current.resume()
    })
    expect(ok).toBeFalsy()

    vi.mocked(agentAPI.resume).mockResolvedValue({ resumed: false })
    await act(async () => {
      ok = await result.current.resume()
    })
    expect(ok).toBeFalsy()

    vi.mocked(agentAPI.resume).mockResolvedValue({ resumed: true })
    await act(async () => {
      ok = await result.current.resume()
    })
    expect(ok).toBe(true)
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

/**
 * 会话级控制态必须随会话走。paused/busy/error 都描述「这一条会话的运行」，而本 hook
 * 的实例在同 path 换 sessionId 时不会重建（ChatSession 自述），Chat 也不重建——
 * 在 A 上暂停失败（或撞上 {paused:false}）后切到 B，A 的红条与 paused=true 会整块挂到
 * B 上：B 的对话在跑，顶栏却写「恢复」，点下去只会拿到「没有可恢复的运行」。
 */
describe('useAgent 切会话复位', () => {
  it('切会话后清掉上一条会话的失败原因与暂停态', async () => {
    vi.mocked(agentAPI.pause).mockResolvedValue({ paused: true })
    const { result, rerender } = renderHook(({ sid }) => useAgent(sid), {
      initialProps: { sid: 's1' },
    })

    await act(async () => {
      await result.current.pause()
    })
    expect(result.current.paused).toBe(true)

    rerender({ sid: 's2' })

    expect(result.current.paused).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.busy).toBe(false)
  })

  it('切会话后清掉上一条会话的红条', async () => {
    vi.mocked(agentAPI.pause).mockRejectedValue(new Error('没有可暂停的运行'))
    const { result, rerender } = renderHook(({ sid }) => useAgent(sid), {
      initialProps: { sid: 's1' },
    })

    await act(async () => {
      await result.current.pause()
    })
    expect(result.current.error).toBe('没有可暂停的运行')

    rerender({ sid: 's2' })
    expect(result.current.error).toBeNull()
  })

  it('在飞的暂停响应在切会话后不得写进新会话', async () => {
    let resolvePause: (v: { paused: boolean }) => void = () => {}
    vi.mocked(agentAPI.pause).mockReturnValue(
      new Promise((r) => {
        resolvePause = r
      }),
    )
    const { result, rerender } = renderHook(({ sid }) => useAgent(sid), {
      initialProps: { sid: 's1' },
    })

    let pending: Promise<void> | undefined
    act(() => {
      pending = result.current.pause()
    })
    expect(result.current.busy).toBe(true)

    rerender({ sid: 's2' })

    // A 的响应此刻才落地：B 上不得翻成暂停态，也不得继续占着 busy
    await act(async () => {
      resolvePause({ paused: true })
      await pending
    })

    expect(result.current.paused).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.busy).toBe(false)
  })

  it('在飞的暂停失败在切会话后不得把红条挂到新会话', async () => {
    let rejectPause: (e: unknown) => void = () => {}
    vi.mocked(agentAPI.pause).mockReturnValue(
      new Promise((_r, rej) => {
        rejectPause = rej
      }),
    )
    const { result, rerender } = renderHook(({ sid }) => useAgent(sid), {
      initialProps: { sid: 's1' },
    })

    let pending: Promise<void> | undefined
    act(() => {
      pending = result.current.pause()
    })

    rerender({ sid: 's2' })
    await act(async () => {
      rejectPause(new Error('服务未启动'))
      await pending
    })

    expect(result.current.error).toBeNull()
    expect(result.current.busy).toBe(false)
  })
})
