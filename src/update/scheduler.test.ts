import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUpdateScheduler } from './scheduler.js'
import type { UpdateCheckResult } from './version.js'

function result(hasUpdate: boolean, latest = '0.2.0'): UpdateCheckResult {
  return {
    hasUpdate,
    currentVersion: '0.1.0',
    latestVersion: hasUpdate ? latest : '0.1.0',
  }
}

/**
 * 用假 timer 驱动调度器；每个 it 自带 afterEach 恢复真实 timer + stop scheduler，
 * 防止悬挂的 interval 跨用例泄漏（spec §18.1 后台定期检查）。
 */
describe('createUpdateScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('getLastResult 是 null 直到首次检查完成', () => {
    const checkFn = vi.fn().mockResolvedValue(result(false))
    const s = createUpdateScheduler({ checkFn })
    expect(s.getLastResult()).toBeNull()
    s.stop()
  })

  it('start 后等待 initialDelayMs 才首次检查', async () => {
    const checkFn = vi.fn().mockResolvedValue(result(false))
    const onUpdate = vi.fn()
    const s = createUpdateScheduler({
      checkFn,
      intervalMs: 60_000,
      initialDelayMs: 5_000,
      onUpdate,
    })
    vi.useFakeTimers()
    s.start()
    // 还没到延迟
    await vi.advanceTimersByTimeAsync(4_999)
    expect(checkFn).not.toHaveBeenCalled()
    // 触发首次
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(checkFn).toHaveBeenCalledTimes(1))
    expect(s.getLastResult()?.hasUpdate).toBe(false)
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ hasUpdate: false }))
    s.stop()
  })

  it('按 intervalMs 周期性检查', async () => {
    const checkFn = vi.fn().mockResolvedValue(result(false))
    const s = createUpdateScheduler({
      checkFn,
      intervalMs: 10_000,
      initialDelayMs: 1_000,
    })
    vi.useFakeTimers()
    s.start()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(checkFn).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(checkFn).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(checkFn).toHaveBeenCalledTimes(3))
    s.stop()
  })

  it('checkNow 立即执行并更新缓存', async () => {
    const checkFn = vi.fn().mockResolvedValue(result(true, '0.3.0'))
    const s = createUpdateScheduler({ checkFn })
    const r = await s.checkNow()
    expect(r.hasUpdate).toBe(true)
    expect(r.latestVersion).toBe('0.3.0')
    expect(s.getLastResult()?.latestVersion).toBe('0.3.0')
    s.stop()
  })

  it('checkFn 抛错时缓存 hasUpdate:false 不传播异常', async () => {
    const checkFn = vi.fn().mockRejectedValue(new Error('network down'))
    const onUpdate = vi.fn()
    const s = createUpdateScheduler({ checkFn, onUpdate })
    const r = await s.checkNow()
    expect(r.hasUpdate).toBe(false)
    expect(s.getLastResult()?.hasUpdate).toBe(false)
    // onUpdate 在异常路径不调用（只在成功检查后通知）
    expect(onUpdate).not.toHaveBeenCalled()
    s.stop()
  })

  it('stop 后不再调度新检查', async () => {
    const checkFn = vi.fn().mockResolvedValue(result(false))
    const s = createUpdateScheduler({
      checkFn,
      intervalMs: 5_000,
      initialDelayMs: 1_000,
    })
    vi.useFakeTimers()
    s.start()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(checkFn).toHaveBeenCalledTimes(1))
    s.stop()
    const count = checkFn.mock.calls.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(checkFn.mock.calls.length).toBe(count)
  })

  it('hasUpdate=true 时 onUpdate 收到完整结果', async () => {
    const checkFn = vi.fn().mockResolvedValue(result(true, '9.9.9'))
    const onUpdate = vi.fn()
    const s = createUpdateScheduler({ checkFn, onUpdate, initialDelayMs: 0 })
    s.start()
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ hasUpdate: true, latestVersion: '9.9.9' }),
    )
    s.stop()
  })
})
