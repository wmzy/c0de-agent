import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
import { sendTool } from './send.js'

/** 最小 ToolContext：send 只消费 steerAgent，其余字段与执行无关。 */
function ctxWith(steerAgent?: ToolContext['steerAgent']): ToolContext {
  return {
    cwd: '/tmp',
    session: { id: '00000000-0000-0000-0000-000000000001', cwd: '/tmp' },
    abort: new AbortController().signal,
    ...(steerAgent ? { steerAgent } : {}),
  }
}

describe('send tool', () => {
  it('delivers a message via steerAgent and reports turn-boundary semantics', async () => {
    const calls: Array<{ id: string; msg: string }> = []
    const res = await sendTool.execute(
      { sessionId: 'target-1', message: '优先处理解析器模块' },
      ctxWith((sessionId, message) => {
        calls.push({ id: sessionId, msg: message })
        return { delivered: true, detail: 'queued' }
      }),
    )
    expect(res._tag).toBe('success')
    expect(calls).toEqual([{ id: 'target-1', msg: '优先处理解析器模块' }])
  })

  it('returns an error with target-state hint when delivery fails', async () => {
    const res = await sendTool.execute(
      { sessionId: 'gone', message: 'hello' },
      ctxWith(() => ({ delivered: false, detail: 'no active run' })),
    )
    expect(res._tag).toBe('error')
    if (res._tag === 'error') expect(res.error).toContain('no active run')
  })

  it('reports not-available when the host injects no registry (CLI)', async () => {
    const res = await sendTool.execute({ sessionId: 'x', message: 'hi' }, ctxWith())
    expect(res._tag).toBe('error')
    if (res._tag === 'error') expect(res.error).toContain('not available')
  })

  it('rejects empty sessionId or blank message', async () => {
    const res = await sendTool.execute(
      { sessionId: '', message: '   ' },
      ctxWith(() => ({ delivered: true, detail: '' })),
    )
    expect(res._tag).toBe('error')
  })
})
