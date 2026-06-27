import { describe, it, expect } from 'vitest'
import type { ToolDef } from '../shared/types/tool.js'
import { createPermissionChecker, autoAllowChecker } from './permission.js'

function makeTool(permission: 'auto' | 'ask' | 'deny'): ToolDef {
  return {
    name: 'test',
    description: 'test',
    parameters: { type: 'object' },
    permission,
    execute: async () => ({ _tag: 'success', output: '' }),
  }
}

describe('autoAllowChecker', () => {
  it('allows auto tools', async () => {
    const result = await autoAllowChecker.check(makeTool('auto'), {}, {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: new AbortController().signal,
    })
    expect(result._tag).toBe('allow')
  })

  it('asks for ask tools', async () => {
    const result = await autoAllowChecker.check(makeTool('ask'), {}, {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: new AbortController().signal,
    })
    expect(result._tag).toBe('ask')
    if (result._tag === 'ask') {
      expect(result.reason).toBeTruthy()
      expect(result.toolCallId).toBeTruthy()
    }
  })

  it('denies deny tools', async () => {
    const result = await autoAllowChecker.check(makeTool('deny'), {}, {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: new AbortController().signal,
    })
    expect(result._tag).toBe('deny')
  })
})

describe('createPermissionChecker', () => {
  it('uses provided config for allowed/denied tool names', async () => {
    const checker = createPermissionChecker({
      alwaysAllow: ['bash'],
      alwaysDeny: ['rm'],
    })
    const ctx = {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: new AbortController().signal,
    }

    // bash is 'ask' but explicitly allowed
    const bashTool = makeTool('ask')
    bashTool.name = 'bash'
    const bashResult = await checker.check(bashTool, {}, ctx)
    expect(bashResult._tag).toBe('allow')

    // rm is 'auto' but explicitly denied
    const rmTool = makeTool('auto')
    rmTool.name = 'rm'
    const rmResult = await checker.check(rmTool, {}, ctx)
    expect(rmResult._tag).toBe('deny')
  })

  it('falls through to tool permission for unlisted tools', async () => {
    const checker = createPermissionChecker({})
    const ctx = {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: new AbortController().signal,
    }
    const result = await checker.check(makeTool('ask'), {}, ctx)
    expect(result._tag).toBe('ask')
  })

  it('confirm is a no-op by default', () => {
    const checker = createPermissionChecker({})
    expect(() => checker.confirm('tc1', true)).not.toThrow()
  })

  it('generates unique toolCallIds', async () => {
    const ctx = {
      cwd: '/tmp',
      session: { id: 's1', cwd: '/tmp' },
      abort: new AbortController().signal,
    }
    const r1 = await autoAllowChecker.check(makeTool('ask'), {}, ctx)
    const r2 = await autoAllowChecker.check(makeTool('ask'), {}, ctx)
    if (r1._tag === 'ask' && r2._tag === 'ask') {
      expect(r1.toolCallId).not.toBe(r2.toolCallId)
    }
  })
})
