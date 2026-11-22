// 交互辅助 hooks（usePromptPrediction / useIdleRecap）：触发条件、去抖、
// 作废与「每会话一次」口径。assist API mock 掉（端点行为在服务端测试锁定）。
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useIdleRecap } from '@/hooks/useIdleRecap.js'
import { PREDICTION_DEBOUNCE_MS, usePromptPrediction } from '@/hooks/usePromptPrediction.js'

const predictPrompt = vi.fn()
const recap = vi.fn()
vi.mock('@/services/assist.js', () => ({
  assistAPI: {
    predictPrompt: (...args: unknown[]) => predictPrompt(...(args as [])),
    recap: (...args: unknown[]) => recap(...(args as [])),
  },
}))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** 推进微任务链（fake timers 下 waitFor 会挂起——它轮询用的 setInterval 也是假的）。 */
async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('usePromptPrediction', () => {
  const base = {
    sessionId: 's1',
    enabled: true,
    isEmpty: true,
    isStreaming: false,
    hasMessages: true,
  }

  it('空闲去抖后请求，prediction 进入状态', async () => {
    predictPrompt.mockResolvedValue({ prediction: '继续' })
    const { result } = renderHook(() => usePromptPrediction(base))
    expect(result.current.prediction).toBeNull()
    advance(PREDICTION_DEBOUNCE_MS)
    await flush()
    expect(result.current.prediction).toBe('继续')
    expect(predictPrompt).toHaveBeenCalledWith('s1')
  })

  it('去抖窗口内开始输入 → 不发请求', () => {
    const { result, rerender } = renderHook(
      ({ isEmpty }: { isEmpty: boolean }) => usePromptPrediction({ ...base, isEmpty }),
      { initialProps: { isEmpty: true } },
    )
    rerender({ isEmpty: false })
    advance(PREDICTION_DEBOUNCE_MS + 100)
    expect(predictPrompt).not.toHaveBeenCalled()
    expect(result.current.prediction).toBeNull()
  })

  it('流式中/无会话/未开启/空会话 → 恒不请求', () => {
    for (const patch of [
      { isStreaming: true },
      { sessionId: undefined },
      { enabled: false },
      { hasMessages: false },
    ] as const) {
      renderHook(() => usePromptPrediction({ ...base, ...patch }))
    }
    advance(PREDICTION_DEBOUNCE_MS + 100)
    expect(predictPrompt).not.toHaveBeenCalled()
  })

  it('clearPrediction 置空且作废在途结果（Esc 后新一轮请求不再回填旧值）', async () => {
    let resolveFirst: (v: { prediction: string | null }) => void = () => {}
    predictPrompt.mockReturnValue(
      new Promise((r) => {
        resolveFirst = r
      }),
    )
    const { result } = renderHook(() => usePromptPrediction(base))
    advance(PREDICTION_DEBOUNCE_MS)
    act(() => result.current.clearPrediction())
    // 在途请求此刻落地：已被作废，不得回填
    resolveFirst({ prediction: '迟到的预测' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.prediction).toBeNull()
  })

  it('请求失败静默（prediction 保持 null）', async () => {
    predictPrompt.mockRejectedValue(new Error('404'))
    const { result } = renderHook(() => usePromptPrediction(base))
    advance(PREDICTION_DEBOUNCE_MS)
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.prediction).toBeNull()
  })
})

describe('useIdleRecap', () => {
  const base = {
    sessionId: 's1',
    enabled: true,
    idleSeconds: 60,
    isStreaming: false,
    hasMessages: true,
    composerEmpty: true,
  }

  it('空闲 idleSeconds 后请求一次，recap 进入状态', async () => {
    recap.mockResolvedValue({ recap: '目标是修 bug', cached: false })
    const { result } = renderHook(() => useIdleRecap(base))
    advance(59_000)
    expect(recap).not.toHaveBeenCalled()
    advance(1_000)
    await flush()
    expect(result.current.recap).toBe('目标是修 bug')
    expect(recap).toHaveBeenCalledTimes(1)
  })

  it('计时窗口内恢复流式 → 取消，不请求', () => {
    const { rerender } = renderHook(
      ({ isStreaming }: { isStreaming: boolean }) => useIdleRecap({ ...base, isStreaming }),
      { initialProps: { isStreaming: false } },
    )
    rerender({ isStreaming: true })
    advance(120_000)
    expect(recap).not.toHaveBeenCalled()
  })

  it('同一会话只触发一次（新一轮流式结束不再重复请求）', async () => {
    recap.mockResolvedValue({ recap: 'r', cached: true })
    const { result, rerender } = renderHook(
      ({ isStreaming }: { isStreaming: boolean }) => useIdleRecap({ ...base, isStreaming }),
      { initialProps: { isStreaming: false } },
    )
    advance(60_000)
    await flush()
    expect(result.current.recap).toBe('r')
    rerender({ isStreaming: true })
    rerender({ isStreaming: false })
    advance(120_000)
    expect(recap).toHaveBeenCalledTimes(1)
  })

  it('切会话后重新计时并允许触发', async () => {
    recap.mockResolvedValue({ recap: 'r2', cached: false })
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useIdleRecap({ ...base, sessionId }),
      { initialProps: { sessionId: 's1' } },
    )
    rerender({ sessionId: 's2' })
    advance(60_000)
    await flush()
    expect(result.current.recap).toBe('r2')
    expect(recap).toHaveBeenCalledWith('s2')
  })
})
