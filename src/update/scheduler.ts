import type { UpdateCheckResult } from './version.js'

/**
 * 后台版本检查调度器（spec §18.1 步骤 1）。
 *
 * 启动时延迟 initialDelayMs 后执行首次 checkForUpdate，之后按 intervalMs
 * 周期性检查。结果缓存到内存，供 /api/update 路由读取（避免每次请求都打
 * npm registry）。发现新版本通过 onUpdate 回调通知上层（server.ts 转发到
 * 前端 SSE 或前端轮询读取）。
 *
 * checkFn 抛错时不传播，缓存降级为 hasUpdate:false（与 checkForUpdate 自身
 * 的容错语义一致）。
 */
type UpdateSchedulerOptions = {
  checkFn: () => Promise<UpdateCheckResult>
  /** 周期检查间隔（毫秒），默认 1 小时。 */
  intervalMs?: number
  /** 首次检查延迟（毫秒），默认 10 秒。 */
  initialDelayMs?: number
  /** 每次成功检查后回调（含 hasUpdate:false）；异常路径不调用。 */
  onUpdate?: (result: UpdateCheckResult) => void
}

type UpdateScheduler = {
  /** 启动调度（首次延迟 + 周期检查）。重复 start 是 no-op。 */
  start(): void
  /** 停止调度；已缓存的 lastResult 保留。 */
  stop(): void
  /** 立即触发一次检查并更新缓存；异常降级为 hasUpdate:false。 */
  checkNow(): Promise<UpdateCheckResult>
  /** 当前缓存结果；未检查过返回 null。 */
  getLastResult(): UpdateCheckResult | null
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_INITIAL_DELAY_MS = 10_000

function createUpdateScheduler(opts: UpdateSchedulerOptions): UpdateScheduler {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  // 直接引用全局 timer；vitest useFakeTimers() 会替换全局，start() 时读取即拿到 mock。
  let intervalId: ReturnType<typeof setInterval> | null = null
  let initialId: ReturnType<typeof setTimeout> | null = null
  let lastResult: UpdateCheckResult | null = null
  let started = false

  async function runOnce(): Promise<UpdateCheckResult> {
    let r: UpdateCheckResult
    try {
      r = await opts.checkFn()
    } catch {
      // 异常降级：缓存 hasUpdate:false，但不触发 onUpdate（避免误报）。
      lastResult = { hasUpdate: false, currentVersion: '0.0.0', latestVersion: '0.0.0' }
      return lastResult
    }
    lastResult = r
    if (opts.onUpdate) opts.onUpdate(r)
    return r
  }

  return {
    start(): void {
      if (started) return
      started = true
      // 首次延迟：到达后执行 runOnce，再挂周期 interval。
      // 不能直接 setInterval——initialDelayMs 与 intervalMs 通常不同。
      initialId = setTimeout(() => {
        void runOnce()
        intervalId = setInterval(() => void runOnce(), intervalMs)
      }, initialDelayMs)
    },
    stop(): void {
      if (initialId !== null) {
        clearTimeout(initialId)
        initialId = null
      }
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
      started = false
    },
    checkNow(): Promise<UpdateCheckResult> {
      return runOnce()
    },
    getLastResult(): UpdateCheckResult | null {
      return lastResult
    },
  }
}

export type { UpdateScheduler, UpdateSchedulerOptions }
export { createUpdateScheduler }
