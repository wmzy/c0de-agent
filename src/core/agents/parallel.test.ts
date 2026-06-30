import { describe, expect, it } from 'vitest'
import { mapWithConcurrencyLimit } from './parallel.js'

describe('mapWithConcurrencyLimit', () => {
  it('按序返回结果', async () => {
    const items = [1, 2, 3]
    const { results, aborted } = await mapWithConcurrencyLimit(items, 2, async (item) => item * 2)
    expect(results).toEqual([2, 4, 6])
    expect(aborted).toBe(false)
  })

  it('尊重并发上限', async () => {
    let active = 0
    let maxActive = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    await mapWithConcurrencyLimit(items, 3, async (item) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return item
    })
    expect(maxActive).toBeLessThanOrEqual(3)
  })

  it('abort 时取消未启动的，保留已完成', async () => {
    const ctrl = new AbortController()
    const items = [1, 2, 3, 4, 5]
    setTimeout(() => ctrl.abort(), 30)
    const { results, aborted } = await mapWithConcurrencyLimit(
      items,
      1,
      async (item) => {
        await new Promise((r) => setTimeout(r, 20))
        return item
      },
      ctrl.signal,
    )
    expect(aborted).toBe(true)
    expect(results.filter((r) => r !== undefined).length).toBeGreaterThan(0)
  })

  it('任一失败立即 reject', async () => {
    const items = [1, 2, 3]
    await expect(
      mapWithConcurrencyLimit(items, 2, async (item) => {
        if (item === 2) throw new Error('boom')
        return item
      }),
    ).rejects.toThrow('boom')
  })
})
