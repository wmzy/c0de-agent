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

  it('数组含空洞/undefined 元素时后续项仍被处理（worker 不提前退出）', async () => {
    // 复现：worker 取到退化元素（稀疏数组的空洞 / 显式 undefined）时直接 return，
    // 该 worker 永久退出——并发为 1 时其后的全部任务静默跳过，results 留下空洞，
    // 上层（runSubAgents）把被跳过的任务误报为「run aborted 未启动」。
    const items = [1, undefined, 3, 4] as Array<number | undefined>
    const processed: number[] = []
    const { results } = await mapWithConcurrencyLimit(items, 1, async (item) => {
      if (item === undefined) return 'hole'
      processed.push(item)
      return item * 2
    })
    expect(processed).toEqual([1, 3, 4])
    // 退化元素槽位由 fn 返回值填充（与 Array.map 语义一致：undefined 是合法入参）；
    // 关键不变量是它之后的项一个不少。
    expect(results[0]).toBe(2)
    expect(results[1]).toBe('hole')
    expect(results[2]).toBe(6)
    expect(results[3]).toBe(8)
    expect(results).toHaveLength(4)
  })

  it('稀疏数组的空洞（delete 制造，与 map 传播空洞同型）不终止 worker', async () => {
    // 真实入口：工作流 ctx.runSubagents 对稀疏 tasks 数组执行 tasks.map(...)，
    // map 跳过空洞 → requests 带洞进并发池，池内 items[idx] 读到 undefined。
    const sparse: Array<number | undefined> = [1, 99, 3]
    delete sparse[1]
    const processed: number[] = []
    const { results } = await mapWithConcurrencyLimit(sparse, 1, async (item) => {
      if (item === undefined) return 'hole'
      processed.push(item)
      return item * 2
    })
    expect(processed).toEqual([1, 3])
    expect(results[0]).toBe(2)
    expect(results[1]).toBe('hole')
    expect(results[2]).toBe(6)
    expect(results).toHaveLength(3)
  })
})
