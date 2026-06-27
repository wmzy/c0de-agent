// src/plugins/hooks.ts
import type { HookHandler, HookMap, HookRunner, HookRunnerOptions, Logger } from './types.js'
import { createLogger } from './logger.js'

type ErasedHandler = (data: unknown) => unknown | false | Promise<unknown | false | void>

type Registration = {
  handler: ErasedHandler
  priority: number
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hook handler timed out after ${ms}ms`)), ms)
    promise.then(
      (val) => {
        clearTimeout(timer)
        resolve(val)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function sortByPriority(regs: Registration[]): Registration[] {
  return regs.slice().sort((a, b) => a.priority - b.priority)
}

function createHookRunner(opts?: HookRunnerOptions): HookRunner {
  const timeout = opts?.timeout ?? 5000
  const logger: Logger = opts?.logger ?? createLogger('hooks')
  const handlers = new Map<string, Registration[]>()

  const on = (
    event: keyof HookMap,
    handler: ErasedHandler,
    priority: number,
  ): void => {
    const key = event as string
    const regs = handlers.get(key) ?? []
    regs.push({ handler, priority })
    handlers.set(key, regs)
  }

  const off = (event: keyof HookMap, handler: ErasedHandler): void => {
    const key = event as string
    const regs = handlers.get(key)
    if (!regs) return
    const filtered = regs.filter((r) => r.handler !== handler)
    handlers.set(key, filtered)
  }

  const runHooks = async <K extends keyof HookMap>(
    event: K,
    data: HookMap[K],
  ): Promise<HookMap[K] | false> => {
    const regs = handlers.get(event as string)
    if (!regs || regs.length === 0) return data
    let current: unknown = data
    for (const reg of sortByPriority(regs)) {
      try {
        const result = await withTimeout(
          Promise.resolve(reg.handler(current)),
          timeout,
        )
        if (result === false) return false
        if (result !== undefined) current = result
      } catch (err) {
        logger.warn(`Handler for "${String(event)}" failed:`, err)
      }
    }
    return current as HookMap[K]
  }

  const fireHooks = async <K extends keyof HookMap>(
    event: K,
    data: HookMap[K],
  ): Promise<void> => {
    const regs = handlers.get(event as string)
    if (!regs || regs.length === 0) return
    await Promise.allSettled(
      sortByPriority(regs).map(async (reg) => {
        try {
          await withTimeout(Promise.resolve(reg.handler(data)), timeout)
        } catch (err) {
          logger.warn(`Handler for "${String(event)}" failed:`, err)
        }
      }),
    )
  }

  const dispose = (): void => {
    handlers.clear()
  }

  return {
    on: ((event: keyof HookMap, handler: ErasedHandler, priority = 100) =>
      on(event, handler, priority)) as HookRunner['on'],
    off: off as HookRunner['off'],
    runHooks: runHooks as HookRunner['runHooks'],
    fireHooks: fireHooks as HookRunner['fireHooks'],
    dispose,
  }
}

export { createHookRunner }
