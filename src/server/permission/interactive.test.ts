// src/server/permission/interactive.test.ts
import { describe, expect, it } from 'vitest'
import type { ToolContext, ToolDef } from '../../shared/types/tool.js'
import { createInteractivePermissionChecker } from './interactive.js'

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

describe('InteractivePermissionChecker', () => {
  it('auto 权限工具直接 allow', async () => {
    const checker = createInteractivePermissionChecker()
    const result = await checker.check(autoTool, {}, ctx)
    expect(result._tag).toBe('allow')
  })

  it('deny 权限工具直接 deny', async () => {
    const checker = createInteractivePermissionChecker()
    const result = await checker.check(denyTool, {}, ctx)
    expect(result._tag).toBe('deny')
  })

  it('alwaysAllow 列表中的工具直接 allow（即使 permission=ask）', async () => {
    const checker = createInteractivePermissionChecker({ alwaysAllow: ['write'] })
    const result = await checker.check(askTool, {}, ctx)
    expect(result._tag).toBe('allow')
  })

  it('alwaysDeny 列表中的工具直接 deny', async () => {
    const checker = createInteractivePermissionChecker({ alwaysDeny: ['read'] })
    const result = await checker.check(autoTool, {}, ctx)
    expect(result._tag).toBe('deny')
  })

  it('ask 权限工具触发 onPermissionRequired 回调并阻塞', async () => {
    let calledWith: { toolCallId: string; tool: string; input: unknown } | null = null
    const checker = createInteractivePermissionChecker({
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
    const checker = createInteractivePermissionChecker({
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
    const checker = createInteractivePermissionChecker()
    expect(checker.confirm('nonexistent', true)).toBe(false)
  })

  it('hasPending 对不存在的 id 返回 false', () => {
    const checker = createInteractivePermissionChecker()
    expect(checker.hasPending('nope')).toBe(false)
  })
})
