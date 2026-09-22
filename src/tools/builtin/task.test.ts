import { describe, expect, it, vi } from 'vitest'
import type { SubAgentRequest, SubAgentResult, ToolContext } from '../../shared/types/tool.js'
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

describe('taskTool 批量派发的并发契约', () => {
  it('批量 tasks[] 走宿主批量入口（并发策略由宿主按 subagentConcurrency 实现）', async () => {
    const runSubAgents = vi.fn(
      async (requests: SubAgentRequest[]): Promise<SubAgentResult[]> =>
        requests.map((r) => ({
          _tag: 'success' as const,
          output: `ok:${r.prompt}`,
          sessionId: 'c',
        })),
    )
    const result = await taskTool.execute(
      {
        subagent_type: 'coder',
        context: 'refactor X',
        tasks: [
          { description: 'API 层', assignment: 'do A' },
          { description: '测试层', assignment: 'do B' },
          { description: '文档层', assignment: 'do C' },
        ],
      },
      { ...ctxWith(), runSubAgents },
    )
    // 一次性交出全部请求：逐个 await 会把 N 个子 agent 的墙钟时间线性叠加
    expect(runSubAgents).toHaveBeenCalledTimes(1)
    expect(runSubAgents.mock.calls[0]?.[0]).toHaveLength(3)
    expect(runSubAgents.mock.calls[0]?.[0]?.[0]).toMatchObject({
      agentType: 'coder',
      prompt: 'do A',
      description: 'API 层',
      context: 'refactor X',
    })
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('ok:do A')
      expect(result.output).toContain('ok:do C')
    }
  })

  it('宿主未注入批量入口时回退逐个派发（单任务入口），结果按输入顺序聚合', async () => {
    const runSubAgent = vi.fn(
      async (req: SubAgentRequest): Promise<SubAgentResult> => ({
        _tag: 'success',
        output: `ok:${req.prompt}`,
        sessionId: 'c',
      }),
    )
    const result = await taskTool.execute(
      {
        subagent_type: 'coder',
        context: 'ref',
        tasks: [{ assignment: 'do A' }, { assignment: 'do B' }],
      },
      ctxWith(runSubAgent),
    )
    expect(runSubAgent).toHaveBeenCalledTimes(2)
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output.indexOf('ok:do A')).toBeLessThan(result.output.indexOf('ok:do B'))
    }
  })

  it('批量中某个子 agent 失败：报错但不吞掉已完成任务的结果', async () => {
    const runSubAgents = vi.fn(
      async (): Promise<SubAgentResult[]> => [
        { _tag: 'success', output: 'done A', sessionId: 'c1' },
        { _tag: 'error', error: 'boom' },
      ],
    )
    const result = await taskTool.execute(
      { subagent_type: 'coder', context: 'ref', tasks: [{ assignment: 'A' }, { assignment: 'B' }] },
      { ...ctxWith(), runSubAgents },
    )
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.error).toContain('boom')
      expect(result.error).toContain('done A')
    }
  })
})
