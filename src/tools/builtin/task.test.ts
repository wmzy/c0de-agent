import { describe, expect, it, vi } from 'vitest'
import type { SubAgentResult, ToolContext } from '../../shared/types/tool.js'
import { taskTool } from './task.js'

function ctxWith(runSubAgent?: ToolContext['runSubAgent']): ToolContext {
  return {
    cwd: '/tmp',
    session: { id: 'parent', cwd: '/tmp' },
    abort: new AbortController().signal,
    ...(runSubAgent ? { runSubAgent } : {}),
  }
}

describe('taskTool', () => {
  it('has the correct tool definition', () => {
    expect(taskTool.name).toBe('task')
    expect(taskTool.permission).toBe('auto')
    expect(taskTool.parameters.required).toContain('prompt')
  })

  it('delegates to runSubAgent and returns its output on success', async () => {
    const runSubAgent = vi.fn(
      async (): Promise<SubAgentResult> => ({
        _tag: 'success',
        output: 'sub-agent produced a plan',
        sessionId: 'child-1',
      }),
    )
    const result = await taskTool.execute({ prompt: 'write tests' }, ctxWith(runSubAgent))
    expect(runSubAgent).toHaveBeenCalledOnce()
    expect(runSubAgent).toHaveBeenCalledWith({
      prompt: 'write tests',
      description: undefined,
      model: undefined,
    })
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('sub-agent produced a plan')
      expect(result.metadata).toMatchObject({ sessionId: 'child-1' })
    }
  })

  it('forwards description and model to runSubAgent', async () => {
    const runSubAgent = vi.fn(
      async (): Promise<SubAgentResult> => ({
        _tag: 'success',
        output: 'ok',
        sessionId: 'child-2',
      }),
    )
    await taskTool.execute(
      { prompt: 'p', description: 'Test runner', model: 'gpt-4o-mini' },
      ctxWith(runSubAgent),
    )
    expect(runSubAgent).toHaveBeenCalledWith({
      prompt: 'p',
      description: 'Test runner',
      model: 'gpt-4o-mini',
    })
  })

  it('returns error when runSubAgent reports failure', async () => {
    const runSubAgent = vi.fn(
      async (): Promise<SubAgentResult> => ({
        _tag: 'error',
        error: 'boom',
      }),
    )
    const result = await taskTool.execute({ prompt: 'p' }, ctxWith(runSubAgent))
    expect(result._tag).toBe('error')
    if (result._tag === 'error') expect(result.error).toContain('boom')
  })

  it('returns error when no sub-agent runner is wired into the context', async () => {
    const result = await taskTool.execute({ prompt: 'p' }, ctxWith())
    expect(result._tag).toBe('error')
    if (result._tag === 'error') expect(result.error).toMatch(/sub.?agent|runner|not/i)
  })
})
