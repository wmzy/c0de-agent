// 记忆/审查管线的接线小件（memory 与 advisor 两域共用的骨架收敛）：
// registry 懒建获取器 + 串行任务 runner。纯接线，无业务决策。

import { buildRegistryFromConfig } from '../core/provider-registry.js'
import type { Registry } from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'

/** registry 获取器（单源口径）：优先外部 getRegistry（server 传 live
 *  registry 感知配置热更）；缺省按 config 自建一次并复用——CLI 短命进程
 *  config 不变，重建无意义。memory 提取/整合与 advisor 审查同口径。 */
export function createLazyRegistry(config: Config, getRegistry?: () => Registry): () => Registry {
  let ownRegistry: Registry | undefined
  return () => {
    if (getRegistry) return getRegistry()
    ownRegistry ??= buildRegistryFromConfig(config)
    return ownRegistry
  }
}

/** 串行任务 runner：submit 把任务排在在途任务之后（同一时刻至多一趟在途，
 *  顺序确定），失败经 onError 吞掉（fire-and-forget 旁路绝不影响主循环）；
 *  链尾自然复位引用。flush 有界等待在途任务（短命进程退出前调用防丢结果）。 */
export interface SerialTaskRunner {
  submit: (task: () => Promise<unknown>, onError: (error: unknown) => void) => void
  flush: (timeoutMs?: number) => Promise<void>
}

export function createSerialRunner(): SerialTaskRunner {
  let inFlight: Promise<void> | undefined
  return {
    submit(task, onError) {
      const run = (inFlight ?? Promise.resolve())
        .then(task)
        .catch((error: unknown) => {
          onError(error)
        })
        .then(() => {
          if (inFlight === run) inFlight = undefined
        })
      inFlight = run
    },
    async flush(timeoutMs = 5000) {
      const pending = inFlight
      if (!pending) return
      // 有界等待：settled 后清 timer，避免定时器把短命进程的事件循环挂住。
      // （不用 Promise.withResolvers：当前 tsconfig lib 目标低于 es2024。）
      let releaseBound: () => void
      const bound = new Promise<void>((resolve) => {
        releaseBound = resolve
      })
      const timer = setTimeout(() => releaseBound(), Math.max(0, timeoutMs))
      try {
        await Promise.race([pending, bound])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
