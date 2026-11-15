/**
 * JSON-RPC pending-map 骨架（单一实现）：MCP client 与 DAP protocol 此前各持
 * 一份同构副本（pending Map + 幂等 settle（清 timer → 出表 → 终结）+ 超时
 * reject + close 时 failAll），已现形状漂移（failAll 一处抽函数一处 inline；
 * pending.set 一处带 timer 一处条件展开），收敛于此。
 *
 * 只管「按 id 登记 / 幂等终结 / 全体失败」；id 计数器语义留在各 client
 * （MCP nextId 从 1、DAP seq 从 0 且 notify 也递增）。超时文案
 * `${label} request "${name}" timed out after ${timeoutMs}ms` 与收敛前
 * 两个 client 的既有文案逐字一致（测试断言依赖，勿改）。
 */

export type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

export type PendingRequests = {
  /** 幂等终结路径：清 timer → 出表 → 终结回调。响应/超时/关闭全部终态必经
   *  此处——各处手写 map-delete/timer-clear 必然漂移（漏清 timer、重复终结）。
   *  未知 id 静默忽略（已超时/已响应）。 */
  settle: (id: number, fn: (p: PendingRequest) => void) => void
  /** 登记一个 pending；timeoutMs > 0 时挂超时定时器（到点按统一文案 reject）。 */
  add: (id: number, handlers: PendingRequest, opts: { timeoutMs: number; name: string }) => void
  /** 终结全部 pending（连接关闭 / 客户端销毁时调用）。 */
  failAll: (message: string) => void
}

/** 创建带标签的 pending 集合（label 进超时文案，如 "MCP" / "DAP"）。 */
export function createPendingRequests(label: string): PendingRequests {
  const pending = new Map<number, PendingRequest & { timer?: ReturnType<typeof setTimeout> }>()

  const settle = (id: number, fn: (p: PendingRequest) => void): void => {
    const p = pending.get(id)
    if (!p) return
    if (p.timer) clearTimeout(p.timer)
    pending.delete(id)
    fn(p)
  }

  return {
    settle,
    add(id, { resolve, reject }, { timeoutMs, name }) {
      const timer =
        timeoutMs > 0
          ? setTimeout(
              () =>
                settle(id, (p) =>
                  p.reject(new Error(`${label} request "${name}" timed out after ${timeoutMs}ms`)),
                ),
              timeoutMs,
            )
          : undefined
      pending.set(id, { resolve, reject, ...(timer ? { timer } : {}) })
    },
    failAll(message) {
      for (const id of Array.from(pending.keys())) {
        settle(id, (p) => p.reject(new Error(message)))
      }
    },
  }
}
