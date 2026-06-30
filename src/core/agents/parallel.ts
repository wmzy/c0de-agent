/** 并行执行结果。 */
interface ParallelResult<R> {
  results: (R | undefined)[]
  aborted: boolean
}

/**
 * 带 concurrency 上限的并行执行（worker 池）。
 * 结果按输入顺序返回。abort 时取消未启动的、保留已完成的。
 * 任一失败立即 reject（fail-fast）。
 */
async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): Promise<ParallelResult<R>> {
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results: (R | undefined)[] = new Array(items.length)
  let nextIndex = 0
  const abortController = new AbortController()
  const workerSignal = signal
    ? AbortSignal.any([signal, abortController.signal])
    : abortController.signal

  async function worker(): Promise<void> {
    while (true) {
      if (workerSignal.aborted) return
      const idx = nextIndex++
      if (idx >= items.length) return
      const item = items[idx]
      if (item === undefined) return
      results[idx] = await fn(item, idx, workerSignal)
    }
  }

  const workers = Array.from({ length: limit }, () => worker())
  try {
    await Promise.all(workers)
  } catch (e) {
    abortController.abort()
    throw e
  }

  return { results, aborted: signal?.aborted ?? false }
}

export { mapWithConcurrencyLimit }
export type { ParallelResult }
