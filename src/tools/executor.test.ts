import { describe, expect, it } from 'vitest'
import type { ToolContext, ToolDef, ToolResult } from '../shared/types/tool.js'
import { executeTool } from './executor.js'
import { autoAllowChecker, createPermissionChecker } from './permission.js'
import { createToolRegistry, registerTool } from './registry.js'

const ctx: ToolContext = {
  cwd: '/tmp',
  session: { id: 's1', cwd: '/tmp' },
  abort: new AbortController().signal,
}

function makeTool(
  name: string,
  execute: (input: unknown) => Promise<ToolResult>,
  permission: 'auto' | 'ask' | 'deny' = 'auto',
): ToolDef {
  return {
    name,
    description: name,
    parameters: {
      type: 'object',
      properties: { msg: { type: 'string' } },
      required: ['msg'],
    },
    permission,
    execute: async (input) => execute(input),
  }
}

describe('executeTool', () => {
  it('executes a valid auto tool', async () => {
    const reg = createToolRegistry()
    registerTool(
      reg,
      makeTool('echo', async (input) => ({
        _tag: 'success',
        output: `echo: ${(input as { msg: string }).msg}`,
      })),
    )
    const result = await executeTool(reg, 'echo', { msg: 'hello' }, ctx, autoAllowChecker)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toBe('echo: hello')
    }
  })

  it('returns error for unknown tool', async () => {
    const reg = createToolRegistry()
    const result = await executeTool(reg, 'nonexistent', {}, ctx, autoAllowChecker)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('nonexistent')
    }
  })

  it('returns error for invalid input', async () => {
    const reg = createToolRegistry()
    registerTool(
      reg,
      makeTool('echo', async () => ({ _tag: 'success', output: '' })),
    )
    const result = await executeTool(reg, 'echo', {}, ctx, autoAllowChecker)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('msg')
    }
  })

  it('returns permission_required for ask tools', async () => {
    const reg = createToolRegistry()
    registerTool(
      reg,
      makeTool('write', async () => ({ _tag: 'success', output: '' }), 'ask'),
    )
    const result = await executeTool(reg, 'write', { msg: 'x' }, ctx, autoAllowChecker)
    expect(result._tag).toBe('permission_required')
  })

  it('returns error for denied tools', async () => {
    const reg = createToolRegistry()
    registerTool(
      reg,
      makeTool('rm', async () => ({ _tag: 'success', output: '' }), 'deny'),
    )
    const result = await executeTool(reg, 'rm', { msg: 'x' }, ctx, autoAllowChecker)
    expect(result._tag).toBe('error')
  })

  it('catches tool execution errors', async () => {
    const reg = createToolRegistry()
    registerTool(
      reg,
      makeTool('boom', async () => {
        throw new Error('kaboom')
      }),
    )
    const result = await executeTool(reg, 'boom', { msg: 'x' }, ctx, autoAllowChecker)
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('kaboom')
    }
  })

  it('truncates large output', async () => {
    const reg = createToolRegistry()
    const longOutput = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
    registerTool(
      reg,
      makeTool('big', async () => ({
        _tag: 'success',
        output: longOutput,
      })),
    )
    const result = await executeTool(reg, 'big', { msg: 'x' }, ctx, autoAllowChecker)
    expect(result._tag).toBe('truncated')
    if (result._tag === 'truncated') {
      expect(result.truncated).toBe(true)
      expect(result.totalLines).toBe(5000)
    }
  })

  it('uses custom permission checker', async () => {
    const reg = createToolRegistry()
    registerTool(
      reg,
      makeTool('bash', async () => ({ _tag: 'success', output: '' }), 'ask'),
    )
    const checker = createPermissionChecker({ alwaysAllow: ['bash'] })
    const result = await executeTool(reg, 'bash', { msg: 'ls' }, ctx, checker)
    expect(result._tag).toBe('success')
  })

  it('honors abort signal', async () => {
    const reg = createToolRegistry()
    const ac = new AbortController()
    ac.abort()
    const abortedCtx: ToolContext = {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: ac.signal,
    }
    registerTool(
      reg,
      makeTool('echo', async () => ({ _tag: 'success', output: 'ok' })),
    )
    const result = await executeTool(reg, 'echo', { msg: 'x' }, abortedCtx, autoAllowChecker)
    expect(result._tag).toBe('error')
  })
})
