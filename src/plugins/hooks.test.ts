// src/plugins/hooks.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createHookRunner } from './hooks.js'

describe('createHookRunner', () => {
  it('returns a HookRunner with all methods', () => {
    const runner = createHookRunner()
    expect(typeof runner.on).toBe('function')
    expect(typeof runner.off).toBe('function')
    expect(typeof runner.runHooks).toBe('function')
    expect(typeof runner.fireHooks).toBe('function')
    expect(typeof runner.dispose).toBe('function')
  })

  it('runHooks returns original data when no handlers registered', async () => {
    const runner = createHookRunner()
    const result = await runner.runHooks('tool:before', {
      tool: 'read',
      input: { path: '/a' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(result).not.toBe(false)
  })

  it('runHooks calls a single handler', async () => {
    const runner = createHookRunner()
    const handler = vi.fn((data) => data)
    runner.on('tool:before', handler)
    const data = {
      tool: 'read',
      input: { path: '/a' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    }
    await runner.runHooks('tool:before', data)
    expect(handler).toHaveBeenCalledWith(data)
  })

  it('runHooks chains handlers in priority order (lower = first)', async () => {
    const runner = createHookRunner()
    const calls: string[] = []
    runner.on(
      'tool:before',
      () => {
        calls.push('second')
      },
      200,
    )
    runner.on(
      'tool:before',
      () => {
        calls.push('first')
      },
      50,
    )
    runner.on(
      'tool:before',
      () => {
        calls.push('third')
      },
      300,
    )
    await runner.runHooks('tool:before', {
      tool: 'read',
      input: {},
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(calls).toEqual(['first', 'second', 'third'])
  })

  it('runHooks passes modified data through the chain', async () => {
    const runner = createHookRunner()
    runner.on(
      'tool:before',
      (data) => {
        return { ...data, input: { ...(data.input as object), modified: true } }
      },
      100,
    )
    runner.on(
      'tool:before',
      (data) => {
        return { ...data, input: { ...(data.input as object), second: true } }
      },
      200,
    )
    const result = await runner.runHooks('tool:before', {
      tool: 'write',
      input: { path: '/a' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(result).not.toBe(false)
    if (result !== false) {
      expect(result.input).toEqual({ path: '/a', modified: true, second: true })
    }
  })

  it('runHooks aborts chain when handler returns false', async () => {
    const runner = createHookRunner()
    const secondHandler = vi.fn()
    runner.on('tool:before', () => false, 100)
    runner.on('tool:before', secondHandler, 200)
    const result = await runner.runHooks('tool:before', {
      tool: 'write',
      input: {},
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(result).toBe(false)
    expect(secondHandler).not.toHaveBeenCalled()
  })

  it('runHooks treats void return as passthrough (no modification)', async () => {
    const runner = createHookRunner()
    const originalData = {
      tool: 'read',
      input: { path: '/a' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    }
    runner.on('tool:before', () => {
      // returns void — should not modify data
    })
    const result = await runner.runHooks('tool:before', originalData)
    expect(result).toEqual(originalData)
  })

  it('runHooks supports async handlers', async () => {
    const runner = createHookRunner()
    runner.on('tool:before', async (data) => {
      await new Promise((r) => setTimeout(r, 10))
      return { ...data, input: { ...(data.input as object), async: true } }
    })
    const result = await runner.runHooks('tool:before', {
      tool: 'read',
      input: {},
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(result).not.toBe(false)
    if (result !== false) {
      expect(result.input).toEqual({ async: true })
    }
  })

  it('runHooks isolates errors — logs warning, continues with last good data', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runner = createHookRunner()
    runner.on(
      'tool:before',
      () => {
        throw new Error('boom')
      },
      100,
    )
    const afterHandler = vi.fn((data) => data)
    runner.on('tool:before', afterHandler, 200)
    const result = await runner.runHooks('tool:before', {
      tool: 'read',
      input: { original: true },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(result).not.toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    expect(afterHandler).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('fireHooks calls all handlers (broadcast)', async () => {
    const runner = createHookRunner()
    const h1 = vi.fn()
    const h2 = vi.fn()
    runner.on('tool:after', h1)
    runner.on('tool:after', h2)
    const data = {
      tool: 'read',
      input: {},
      result: { _tag: 'success' as const, output: 'ok' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    }
    await runner.fireHooks('tool:after', data)
    expect(h1).toHaveBeenCalledWith(data)
    expect(h2).toHaveBeenCalledWith(data)
  })

  it('fireHooks ignores handler return values', async () => {
    const runner = createHookRunner()
    const handler = vi.fn((data) => data)
    runner.on('tool:after', handler)
    await runner.fireHooks('tool:after', {
      tool: 'read',
      input: {},
      result: { _tag: 'success' as const, output: 'ok' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(handler).toHaveBeenCalled()
  })

  it('fireHooks isolates errors — one failing handler does not affect others', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runner = createHookRunner()
    const goodHandler = vi.fn()
    runner.on('tool:after', () => {
      throw new Error('boom')
    })
    runner.on('tool:after', goodHandler)
    await runner.fireHooks('tool:after', {
      tool: 'read',
      input: {},
      result: { _tag: 'success' as const, output: 'ok' },
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(goodHandler).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('off removes a specific handler', async () => {
    const runner = createHookRunner()
    const handler = vi.fn()
    runner.on('tool:before', handler)
    runner.off('tool:before', handler)
    await runner.runHooks('tool:before', {
      tool: 'read',
      input: {},
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('dispose removes all handlers', async () => {
    const runner = createHookRunner()
    const handler = vi.fn()
    runner.on('tool:before', handler)
    runner.dispose()
    await runner.runHooks('tool:before', {
      tool: 'read',
      input: {},
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('timeout: handler exceeding timeout is skipped in chain mode', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runner = createHookRunner({ timeout: 100 })
    const nextHandler = vi.fn((data) => data)
    runner.on(
      'tool:before',
      async () => {
        await new Promise((r) => setTimeout(r, 500))
      },
      100,
    )
    runner.on('tool:before', nextHandler, 200)
    const promise = runner.runHooks('tool:before', {
      tool: 'read',
      input: {},
      ctx: { cwd: '/', session: { id: 's1', cwd: '/' }, abort: new AbortController().signal },
    })
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).not.toBe(false)
    expect(nextHandler).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
    vi.useRealTimers()
  })
})
