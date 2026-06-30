import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
import { yieldTool } from './yield.js'

function ctxWith(collectYield?: ToolContext['collectYield']): ToolContext {
  return {
    cwd: '/tmp',
    session: { id: 'child', cwd: '/tmp' },
    abort: new AbortController().signal,
    ...(collectYield ? { collectYield } : {}),
  }
}

describe('yieldTool', () => {
  it('工具定义正确', () => {
    expect(yieldTool.name).toBe('yield')
    expect(yieldTool.permission).toBe('auto')
    expect(yieldTool.parameters.required).toContain('data')
  })

  it('调用 collectYield 收集 data 并返回 success', async () => {
    const collectYield = vi.fn()
    const result = await yieldTool.execute({ data: { summary: 'done' } }, ctxWith(collectYield))
    expect(collectYield).toHaveBeenCalledWith({ summary: 'done' })
    expect(result._tag).toBe('success')
  })

  it('支持 type/status/error 字段', async () => {
    const collectYield = vi.fn()
    await yieldTool.execute(
      { data: {}, type: 'section1', status: 'success' },
      ctxWith(collectYield),
    )
    expect(collectYield).toHaveBeenCalledWith({})
  })

  it('blocked 时携带 error 字段', async () => {
    const collectYield = vi.fn()
    const result = await yieldTool.execute(
      { data: {}, status: 'aborted', error: 'tried everything' },
      ctxWith(collectYield),
    )
    expect(result._tag).toBe('success')
    expect(collectYield).toHaveBeenCalledOnce()
  })
})
