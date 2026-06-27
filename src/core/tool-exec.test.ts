import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../shared/types/tool.js'
import { createDefaultRegistry } from '../tools/index.js'
import { autoAllowChecker } from '../tools/permission.js'
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
