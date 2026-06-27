import { describe, expect, it, vi } from 'vitest'
import { createHookRunner } from '../plugins/hooks.js'
import type { ToolContext } from '../shared/types/tool.js'
import { createDefaultRegistry } from '../tools/index.js'
import { autoAllowChecker } from '../tools/permission.js'
import type { PermissionChecker, ToolRegistry } from '../tools/types.js'
import { executeToolCall, executeToolCalls, partitionByConflict } from './tool-exec.js'

const registry = createDefaultRegistry()
const permission = autoAllowChecker

function makeCtx(): ToolContext {
  return {
    cwd: process.cwd(),
    session: { id: 's1', cwd: process.cwd() },
    abort: new AbortController().signal,
  }
}

describe('executeToolCall', () => {
  it('executes a read tool successfully', async () => {
    const result = await executeToolCall(registry, permission, makeCtx(), 'read', {
      path: 'package.json',
      limit: 5,
    })
    expect(result._tag).toBe('success')
  })

  it('returns error for unknown tool', async () => {
    const result = await executeToolCall(registry, permission, makeCtx(), 'nonexistent', {})
    expect(result._tag).toBe('error')
  })

  it('returns error for invalid input', async () => {
    const result = await executeToolCall(registry, permission, makeCtx(), 'read', {})
    expect(result._tag).toBe('error')
  })
})

describe('executeToolCalls', () => {
  it('executes multiple read calls in parallel', async () => {
    const calls = [
      { id: '1', tool: 'read', input: { path: 'package.json', limit: 3 } },
      { id: '2', tool: 'read', input: { path: 'tsconfig.json', limit: 3 } },
    ]
    const results = await executeToolCalls(registry, permission, makeCtx(), calls)
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.result._tag === 'success')).toBe(true)
  })

  it('returns results keyed by call id', async () => {
    const calls = [{ id: 'a', tool: 'read', input: { path: 'package.json', limit: 1 } }]
    const results = await executeToolCalls(registry, permission, makeCtx(), calls)
    expect(results[0]?.id).toBe('a')
  })
})

describe('partitionByConflict', () => {
  it('puts two writes to same path in serial', () => {
    const calls = [
      { id: '1', tool: 'write', input: { path: '/a', content: 'x' } },
      { id: '2', tool: 'write', input: { path: '/a', content: 'y' } },
    ]
    const { parallel, serial } = partitionByConflict(calls)
    expect(parallel).toHaveLength(1)
    expect(serial).toHaveLength(1)
  })

  it('puts two writes to different paths in parallel', () => {
    const calls = [
      { id: '1', tool: 'write', input: { path: '/a', content: 'x' } },
      { id: '2', tool: 'write', input: { path: '/b', content: 'y' } },
    ]
    const { parallel, serial } = partitionByConflict(calls)
    expect(parallel).toHaveLength(2)
    expect(serial).toHaveLength(0)
  })

  it('puts all read calls in parallel', () => {
    const calls = [
      { id: '1', tool: 'read', input: { path: '/a' } },
      { id: '2', tool: 'read', input: { path: '/a' } },
    ]
    const { parallel, serial } = partitionByConflict(calls)
    expect(parallel).toHaveLength(2)
    expect(serial).toHaveLength(0)
  })
})

describe('executeToolCall with hookRunner', () => {
  it('runs tool:before hook before execution', async () => {
    const hookRunner = createHookRunner()
    const beforeHandler = vi.fn((data) => data)
    hookRunner.on('tool:before', beforeHandler)

    const mockRegistry = {
      tools: new Map([
        [
          'test',
          {
            name: 'test',
            description: 'test',
            parameters: { type: 'object' },
            permission: 'auto',
            execute: async () => ({ _tag: 'success' as const, output: 'ok' }),
          },
        ],
      ]),
      factories: new Map(),
    }
    const mockPermission = { check: async () => ({ _tag: 'allow' as const }) }
    const ctx = { cwd: '/', session: { id: 's', cwd: '/' }, abort: new AbortController().signal }

    await executeToolCall(
      mockRegistry as unknown as ToolRegistry,
      mockPermission as unknown as PermissionChecker,
      ctx,
      'test',
      { foo: 1 },
      hookRunner,
    )
    expect(beforeHandler).toHaveBeenCalled()
  })

  it('aborts when tool:before returns false', async () => {
    const hookRunner = createHookRunner()
    hookRunner.on('tool:before', () => false)

    const executeFn = vi.fn()
    const mockRegistry = {
      tools: new Map([
        [
          'blocked',
          {
            name: 'blocked',
            description: 'test',
            parameters: { type: 'object' },
            permission: 'auto',
            execute: executeFn,
          },
        ],
      ]),
      factories: new Map(),
    }
    const mockPermission = { check: async () => ({ _tag: 'allow' as const }) }
    const ctx = { cwd: '/', session: { id: 's', cwd: '/' }, abort: new AbortController().signal }

    const result = await executeToolCall(
      mockRegistry as unknown as ToolRegistry,
      mockPermission as unknown as PermissionChecker,
      ctx,
      'blocked',
      {},
      hookRunner,
    )
    expect(result._tag).toBe('error')
    expect(executeFn).not.toHaveBeenCalled()
  })

  it('uses modified input from tool:before hook', async () => {
    const hookRunner = createHookRunner()
    hookRunner.on('tool:before', (data) => ({
      ...data,
      input: { ...(data.input as object), injected: true },
    }))

    let receivedInput: unknown
    const mockRegistry = {
      tools: new Map([
        [
          'mod',
          {
            name: 'mod',
            description: 'test',
            parameters: { type: 'object' },
            permission: 'auto',
            execute: async (input: unknown) => {
              receivedInput = input
              return { _tag: 'success' as const, output: 'ok' }
            },
          },
        ],
      ]),
      factories: new Map(),
    }
    const mockPermission = { check: async () => ({ _tag: 'allow' as const }) }
    const ctx = { cwd: '/', session: { id: 's', cwd: '/' }, abort: new AbortController().signal }

    await executeToolCall(
      mockRegistry as unknown as ToolRegistry,
      mockPermission as unknown as PermissionChecker,
      ctx,
      'mod',
      { original: true },
      hookRunner,
    )
    expect(receivedInput).toEqual({ original: true, injected: true })
  })

  it('fires tool:after after execution', async () => {
    const hookRunner = createHookRunner()
    const afterHandler = vi.fn()
    hookRunner.on('tool:after', afterHandler)

    const mockRegistry = {
      tools: new Map([
        [
          'after',
          {
            name: 'after',
            description: 'test',
            parameters: { type: 'object' },
            permission: 'auto',
            execute: async () => ({ _tag: 'success' as const, output: 'done' }),
          },
        ],
      ]),
      factories: new Map(),
    }
    const mockPermission = { check: async () => ({ _tag: 'allow' as const }) }
    const ctx = { cwd: '/', session: { id: 's', cwd: '/' }, abort: new AbortController().signal }

    await executeToolCall(
      mockRegistry as unknown as ToolRegistry,
      mockPermission as unknown as PermissionChecker,
      ctx,
      'after',
      {},
      hookRunner,
    )
    expect(afterHandler).toHaveBeenCalled()
    const callArg = afterHandler.mock.calls[0]?.[0] as { result: { _tag: string } }
    expect(callArg.result._tag).toBe('success')
  })

  it('works without hookRunner (backward compatible)', async () => {
    const mockRegistry = {
      tools: new Map([
        [
          'plain',
          {
            name: 'plain',
            description: 'test',
            parameters: { type: 'object' },
            permission: 'auto',
            execute: async () => ({ _tag: 'success' as const, output: 'ok' }),
          },
        ],
      ]),
      factories: new Map(),
    }
    const mockPermission = { check: async () => ({ _tag: 'allow' as const }) }
    const ctx = { cwd: '/', session: { id: 's', cwd: '/' }, abort: new AbortController().signal }

    const result = await executeToolCall(
      mockRegistry as unknown as ToolRegistry,
      mockPermission as unknown as PermissionChecker,
      ctx,
      'plain',
      {},
    )
    expect(result._tag).toBe('success')
  })
})
