// src/server/permission/interactive.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { ToolContext, ToolDef } from '../../shared/types/tool.js'
import { createInteractivePermissionChecker } from './interactive.js'
import { DEFAULT_PERMISSION_TIMEOUT_MS, createPermissionStore } from './store.js'

const autoTool: ToolDef = {
  name: 'read',
  description: 'read file',
  parameters: { type: 'object', properties: {} },
  permission: 'auto',
  execute: async () => ({ _tag: 'success', output: '' }),
}

const askTool: ToolDef = {
  name: 'write',
  description: 'write file',
  parameters: { type: 'object', properties: {} },
  permission: 'ask',
  execute: async () => ({ _tag: 'success', output: '' }),
}

const denyTool: ToolDef = {
  name: 'danger',
  description: 'dangerous',
  parameters: { type: 'object', properties: {} },
  permission: 'deny',
  execute: async () => ({ _tag: 'success', output: '' }),
}

const ctx: ToolContext = {
  cwd: '/tmp',
  session: { id: 's1', cwd: '/tmp' },
  abort: new AbortController().signal,
}

/** helper：每个 checker 配独立 store */
function makeChecker(
  opts: {
    alwaysAllow?: string[]
    alwaysDeny?: string[]
    getMode?: () => 'default' | 'auto'
    timeoutMs?: number
    onPermissionRequired?: (req: {
      toolCallId: string
      tool: string
      input: unknown
    }) => void | Promise<void>
  } = {},
) {
  const { timeoutMs, ...checkerOpts } = opts
  return createInteractivePermissionChecker(
    createPermissionStore(timeoutMs !== undefined ? { timeoutMs } : {}),
    checkerOpts,
  )
}

describe('InteractivePermissionChecker', () => {
  it('auto 权限工具直接 allow', async () => {
    const checker = makeChecker()
    const result = await checker.check(autoTool, {}, ctx)
    expect(result._tag).toBe('allow')
  })

  it('deny 权限工具直接 deny', async () => {
    const checker = makeChecker()
    const result = await checker.check(denyTool, {}, ctx)
    expect(result._tag).toBe('deny')
  })

  it('alwaysAllow 列表中的工具直接 allow（即使 permission=ask）', async () => {
    const checker = makeChecker({ alwaysAllow: ['write'] })
    const result = await checker.check(askTool, {}, ctx)
    expect(result._tag).toBe('allow')
  })

  it('alwaysDeny 列表中的工具直接 deny', async () => {
    const checker = makeChecker({ alwaysDeny: ['read'] })
    const result = await checker.check(autoTool, {}, ctx)
    expect(result._tag).toBe('deny')
  })

  it('ask 权限工具触发 onPermissionRequired 回调并阻塞', async () => {
    let calledWith: { toolCallId: string; tool: string; input: unknown } | null = null
    const checker = makeChecker({
      onPermissionRequired: (req) => {
        calledWith = req
      },
    })

    const checkPromise = checker.check(askTool, { path: 'test.txt' }, ctx)

    // 回调被调用
    await Promise.resolve()
    expect(calledWith).not.toBeNull()
    const req = calledWith as unknown as { toolCallId: string; tool: string; input: unknown }
    expect(req.tool).toBe('write')
    expect(req.input).toEqual({ path: 'test.txt' })
    expect(checker.hasPending(req.toolCallId)).toBe(true)
    expect(checker.pendingCount()).toBe(1)

    // 确认后解除阻塞
    const confirmed = checker.confirm(req.toolCallId, true)
    expect(confirmed).toBe(true)

    const result = await checkPromise
    expect(result._tag).toBe('allow')
    expect(checker.pendingCount()).toBe(0)
  })

  it('confirm(approved=false) 返回 deny', async () => {
    let captured: string | null = null
    const checker = makeChecker({
      onPermissionRequired: (req) => {
        captured = req.toolCallId
      },
    })
    const checkPromise = checker.check(askTool, {}, ctx)
    await Promise.resolve()
    expect(captured).not.toBeNull()
    checker.confirm(captured as unknown as string, false)
    const result = await checkPromise
    expect(result._tag).toBe('deny')
    void checkPromise
  })

  it('confirm 不存在的 toolCallId 返回 false', () => {
    const checker = makeChecker()
    expect(checker.confirm('nonexistent', true)).toBe(false)
  })

  it('hasPending 对不存在的 id 返回 false', () => {
    const checker = makeChecker()
    expect(checker.hasPending('nope')).toBe(false)
  })

  it('store 独立于 checker 实例——checker 丢弃后 store 仍持有 pending', async () => {
    // 验证架构核心：pending 在全局 store，不挂在 checker/run 上。
    // 即使创建 checker 的 run 被注销（checker 实例丢弃），store 仍能 resolve。
    const store = createPermissionStore()
    let capturedId: string | null = null
    const checker = createInteractivePermissionChecker(store, {
      onPermissionRequired: (req) => {
        capturedId = req.toolCallId
      },
    })

    const checkPromise = checker.check(askTool, { path: 'orphan.txt' }, ctx)
    await Promise.resolve()
    expect(capturedId).not.toBeNull()

    // 模拟 agent run 被注销：checker 实例不再被引用。
    // 但 store 仍持有 pending，confirm 仍能 resolve。
    const id = capturedId as unknown as string
    expect(store.has(id)).toBe(true)
    const ok = store.resolve(id, true)
    expect(ok).toBe(true)

    const result = await checkPromise
    expect(result._tag).toBe('allow')
    expect(store.size()).toBe(0)
  })

  it('getMode=auto 时 ask 工具直接 allow，不阻塞', async () => {
    let called = false
    const checker = makeChecker({
      getMode: () => 'auto',
      onPermissionRequired: () => {
        called = true
      },
    })
    // auto 模式应同步放行；若误走阻塞路径，超时竞态会让用例明确失败而非挂起
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('check 未在 auto 模式立即返回')), 1000),
    )
    const result = await Promise.race([checker.check(askTool, {}, ctx), timeout])
    expect(result._tag).toBe('allow')
    expect(called).toBe(false)
    expect(checker.pendingCount()).toBe(0)
  })

  it('getMode=auto 时 alwaysDeny 仍拒绝（安全边界）', async () => {
    const checker = makeChecker({
      getMode: () => 'auto',
      alwaysDeny: ['write'],
    })
    const result = await checker.check(askTool, {}, ctx)
    expect(result._tag).toBe('deny')
  })

  it('getMode=auto 时 deny 权限工具仍拒绝', async () => {
    const checker = makeChecker({ getMode: () => 'auto' })
    const result = await checker.check(denyTool, {}, ctx)
    expect(result._tag).toBe('deny')
  })

  it('getMode=default 时 ask 行为不变（仍阻塞确认）', async () => {
    let captured: string | null = null
    const checker = makeChecker({
      getMode: () => 'default',
      onPermissionRequired: (req) => {
        captured = req.toolCallId
      },
    })
    const checkPromise = checker.check(askTool, {}, ctx)
    await Promise.resolve()
    expect(captured).not.toBeNull()
    checker.confirm(captured as unknown as string, true)
    const result = await checkPromise
    expect(result._tag).toBe('allow')
  })

  // ── P1#3: pending 超时与 abort 联动 ──────────────────────────
  it('ask 工具超时后自动 deny 并清理 store 条目（端到端）', async () => {
    vi.useFakeTimers()
    try {
      let captured: string | null = null
      const checker = makeChecker({
        timeoutMs: 1000,
        onPermissionRequired: (req) => {
          captured = req.toolCallId
        },
      })
      const checkPromise = checker.check(askTool, { path: 'a.txt' }, ctx)
      // 让 onPermissionRequired 回调 + register 执行
      await Promise.resolve()
      expect(captured).not.toBeNull()
      const id = captured as unknown as string
      expect(checker.hasPending(id)).toBe(true)

      // 不 confirm，推进时间到超时
      vi.advanceTimersByTime(1000)

      const result = await checkPromise
      expect(result._tag).toBe('deny')
      if (result._tag === 'deny') {
        expect(result.reason).toBe('Permission request timed out')
      }
      expect(checker.hasPending(id)).toBe(false)
      expect(checker.pendingCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('正常 confirm 后定时器被 clear：推进时间不重复 resolve', async () => {
    vi.useFakeTimers()
    try {
      let captured: string | null = null
      const checker = makeChecker({
        timeoutMs: 1000,
        onPermissionRequired: (req) => {
          captured = req.toolCallId
        },
      })
      const checkPromise = checker.check(askTool, {}, ctx)
      await Promise.resolve()
      const id = captured as unknown as string

      checker.confirm(id, true)
      const result = await checkPromise
      expect(result._tag).toBe('allow')

      // 推进远超超时；confirm 已 clear 定时器，不应有任何副作用
      vi.advanceTimersByTime(10_000)
      expect(checker.pendingCount()).toBe(0)
      expect(checker.hasPending(id)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('agent abort 时 pending 自动 deny 并清理（abort 联动）', async () => {
    const controller = new AbortController()
    const abortCtx: ToolContext = {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: controller.signal,
    }
    let captured: string | null = null
    const checker = makeChecker({
      onPermissionRequired: (req) => {
        captured = req.toolCallId
      },
    })
    const checkPromise = checker.check(askTool, {}, abortCtx)
    await Promise.resolve()
    const id = captured as unknown as string
    expect(checker.hasPending(id)).toBe(true)

    controller.abort()

    const result = await checkPromise
    expect(result._tag).toBe('deny')
    expect(checker.hasPending(id)).toBe(false)
    expect(checker.pendingCount()).toBe(0)
  })
})

describe('PermissionStore 超时', () => {
  it('超时后自动 deny 并清理条目（注册→不 confirm→推进时间）', () => {
    vi.useFakeTimers()
    try {
      const store = createPermissionStore({ timeoutMs: 1000 })
      const resolve = vi.fn()
      store.register('t2', {
        request: { toolCallId: 't2', tool: 'x', input: {} },
        resolve,
      })
      expect(store.has('t2')).toBe(true)

      vi.advanceTimersByTime(1000)

      expect(resolve).toHaveBeenCalledTimes(1)
      expect(resolve).toHaveBeenCalledWith({
        _tag: 'deny',
        reason: 'Permission request timed out',
      })
      expect(store.has('t2')).toBe(false)
      expect(store.size()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('confirm 后定时器被 clear：超时不再次 resolve（无泄漏）', () => {
    vi.useFakeTimers()
    try {
      const store = createPermissionStore({ timeoutMs: 1000 })
      const resolve = vi.fn()
      store.register('t1', {
        request: { toolCallId: 't1', tool: 'x', input: {} },
        resolve,
      })

      store.resolve('t1', true) // confirm → 应 clear 定时器
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(resolve).toHaveBeenCalledWith({ _tag: 'allow' })

      // 推进远超超时；若未 clear，定时器会再调一次 resolve
      vi.advanceTimersByTime(5000)
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(store.has('t1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('默认超时为 5 分钟（DEFAULT_PERMISSION_TIMEOUT_MS）', () => {
    // 导出常量便于配置/测试引用，值固定 300_000ms
    expect(DEFAULT_PERMISSION_TIMEOUT_MS).toBe(5 * 60 * 1000)
  })
})
