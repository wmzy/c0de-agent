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
      agentType: 'general',
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
      agentType: 'general',
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

describe('taskTool subagent_type + batch', () => {
  it('subagent_type 派发到 runSubAgent', async () => {
    const runSubAgent = vi.fn(
      async (): Promise<SubAgentResult> => ({
        _tag: 'success',
        output: 'researched',
        sessionId: 'child-1',
      }),
    )
    const result = await taskTool.execute(
      { subagent_type: 'researcher', prompt: 'find auth code' },
      ctxWith(runSubAgent),
    )
    expect(runSubAgent).toHaveBeenCalledWith({
      agentType: 'researcher',
      prompt: 'find auth code',
      description: undefined,
      model: undefined,
    })
    expect(result._tag).toBe('success')
  })

  it('无 subagent_type 时默认 general', async () => {
    const runSubAgent = vi.fn(
      async (): Promise<SubAgentResult> => ({ _tag: 'success', output: 'ok', sessionId: 'c' }),
    )
    await taskTool.execute({ prompt: 'p' }, ctxWith(runSubAgent))
    expect(runSubAgent).toHaveBeenCalledWith(expect.objectContaining({ agentType: 'general' }))
  })

  it('批量 tasks[] 模式派发多个子 agent', async () => {
    const runSubAgent = vi.fn(
      async (): Promise<SubAgentResult> => ({ _tag: 'success', output: 'ok', sessionId: 'c' }),
    )
    const result = await taskTool.execute(
      {
        subagent_type: 'coder',
        context: 'refactor X',
        tasks: [
          { description: 'API 层', role: 'api', assignment: 'do A' },
          { description: '测试层', role: 'test', assignment: 'do B' },
        ],
      },
      ctxWith(runSubAgent),
    )
    expect(runSubAgent).toHaveBeenCalledTimes(2)
    expect(runSubAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentType: 'coder',
        prompt: 'do A',
        role: 'api',
        context: 'refactor X',
      }),
    )
    expect(result._tag).toBe('success')
  })

  it('background 模式返回 running 提示', async () => {
    const runSubAgent = vi.fn(
      async (): Promise<SubAgentResult> => ({ _tag: 'running', jobId: 'job-1', sessionId: 'c' }),
    )
    const result = await taskTool.execute(
      { subagent_type: 'coder', prompt: 'p', background: true },
      ctxWith(runSubAgent),
    )
    expect(runSubAgent).toHaveBeenCalledWith(expect.objectContaining({ background: true }))
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.metadata).toMatchObject({ background: true, jobId: 'job-1' })
    }
  })
})
