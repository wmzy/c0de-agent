import { describe, it, expect } from 'vitest'
import type {
  ToolPermission,
  ToolResult,
  ToolContext,
  ToolDef,
} from './tool.js'

describe('ToolResult', () => {
  it('creates a success result', () => {
    const result: ToolResult = {
      _tag: 'success',
      output: 'file contents here',
    }
    expect(result._tag).toBe('success')
  })

  it('creates an error result', () => {
    const result: ToolResult = { _tag: 'error', error: 'File not found' }
    expect(result._tag).toBe('error')
  })

  it('creates a permission_required result', () => {
    const result: ToolResult = {
      _tag: 'permission_required',
      reason: 'bash requires confirmation',
    }
    expect(result._tag).toBe('permission_required')
  })

  it('creates a truncated result', () => {
    const result: ToolResult = {
      _tag: 'truncated',
      output: '...',
      truncated: true,
      totalLines: 5000,
    }
    expect(result._tag).toBe('truncated')
  })
})

describe('ToolPermission', () => {
  it('accepts all permission levels', () => {
    const perms: ToolPermission[] = ['auto', 'ask', 'deny']
    expect(perms).toHaveLength(3)
  })
})

describe('ToolDef', () => {
  it('creates a minimal tool definition', () => {
    const tool: ToolDef = {
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object', properties: {} },
      permission: 'auto',
      execute: async () => ({ _tag: 'success', output: 'ok' }),
    }
    expect(tool.name).toBe('read')
    expect(tool.permission).toBe('auto')
  })

  it('creates a tool definition with timeout and modes', () => {
    const tool: ToolDef = {
      name: 'edit',
      description: 'Edit a file',
      parameters: { type: 'object' },
      permission: 'ask',
      execute: async () => ({ _tag: 'success', output: 'ok' }),
      timeout: 30_000,
      modes: [
        {
          name: 'diff',
          description: 'Standard diff mode',
          isAvailable: () => true,
        },
      ],
    }
    expect(tool.timeout).toBe(30_000)
    expect(tool.modes).toHaveLength(1)
  })
})

describe('ToolContext', () => {
  it('creates a tool context', () => {
    const ctx: ToolContext = {
      cwd: '/home/user/project',
      session: { id: 'sess-1', cwd: '/home/user/project' },
      abort: new AbortController().signal,
    }
    expect(ctx.session.id).toBe('sess-1')
  })
})
