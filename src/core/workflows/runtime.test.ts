import { describe, expect, it, vi } from 'vitest'
import type { AgentDependencies, AgentState } from '../types.js'
import { createWorkflowRegistry } from './registry.js'
import { executeWorkflow } from './runtime.js'
import type { WorkflowContext, WorkflowEntry } from './types.js'

function makeMockDeps(): AgentDependencies {
  return {
    db: {} as AgentDependencies['db'],
    llmRegistry: {} as AgentDependencies['llmRegistry'],
    toolRegistry: {} as AgentDependencies['toolRegistry'],
    permission: {} as AgentDependencies['permission'],
    config: {} as AgentDependencies['config'],
    cwd: '/tmp',
  } as unknown as AgentDependencies
}

function makeMockParent(): AgentState {
  return {
    session: { id: 'test', title: 't', projectId: null },
    messages: [],
    config: { provider: 'x', model: 'x', tools: [], plugins: [], agentName: 'default' },
    // running：超时中止路径要求 status 为 running/paused 才会置 stopped
    status: { _tag: 'running', turnCount: 0 },
    tools: [],
    abortController: new AbortController(),
  } as unknown as AgentState
}

describe('executeWorkflow', () => {
  it('returns error for unknown workflow name', async () => {
    const registry = createWorkflowRegistry()
    const result = await executeWorkflow({
      registry,
      name: 'nonexistent',
      args: '',
      deps: makeMockDeps(),
      parent: makeMockParent(),
    })
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.message).toContain('nonexistent')
    }
  })

  it('executes workflow and returns text result', async () => {
    const registry = createWorkflowRegistry()
    const entry: WorkflowEntry = {
      meta: { name: 'simple', description: 'simple wf' },
      source: 'builtin',
      execute: async () => ({ output: 'workflow completed' }),
    }
    registry.register(entry)
    const result = await executeWorkflow({
      registry,
      name: 'simple',
      args: '',
      deps: makeMockDeps(),
      parent: makeMockParent(),
    })
    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toBe('workflow completed')
    }
  })

  it('returns error message when workflow throws', async () => {
    const registry = createWorkflowRegistry()
    const entry: WorkflowEntry = {
      meta: { name: 'crash', description: 'crashes' },
      source: 'builtin',
      execute: async () => {
        throw new Error('boom')
      },
    }
    registry.register(entry)
    const result = await executeWorkflow({
      registry,
      name: 'crash',
      args: '',
      deps: makeMockDeps(),
      parent: makeMockParent(),
    })
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.message).toContain('boom')
    }
  })

  it('passes args to workflow context', async () => {
    const registry = createWorkflowRegistry()
    let receivedArgs = ''
    const entry: WorkflowEntry = {
      meta: { name: 'argcheck', description: 'checks args' },
      source: 'builtin',
      execute: async (ctx: WorkflowContext) => {
        receivedArgs = ctx.args
        return { output: 'ok' }
      },
    }
    registry.register(entry)
    await executeWorkflow({
      registry,
      name: 'argcheck',
      args: 'my-args-here',
      deps: makeMockDeps(),
      parent: makeMockParent(),
    })
    expect(receivedArgs).toBe('my-args-here')
  })

  it('progress callback fires during execution', async () => {
    const registry = createWorkflowRegistry()
    const entry: WorkflowEntry = {
      meta: { name: 'progress-test', description: 'p' },
      source: 'builtin',
      execute: async (ctx: WorkflowContext) => {
        ctx.progress('step 1')
        ctx.progress('step 2')
        return { output: 'done' }
      },
    }
    registry.register(entry)
    const onProgress = vi.fn()
    await executeWorkflow({
      registry,
      name: 'progress-test',
      args: '',
      deps: makeMockDeps(),
      parent: makeMockParent(),
      onProgress,
    })
    expect(onProgress).toHaveBeenCalledWith('step 1')
    expect(onProgress).toHaveBeenCalledWith('step 2')
  })

  it('default output when workflow returns empty result', async () => {
    const registry = createWorkflowRegistry()
    const entry: WorkflowEntry = {
      meta: { name: 'empty', description: 'no output' },
      source: 'builtin',
      execute: async () => ({}),
    }
    registry.register(entry)
    const result = await executeWorkflow({
      registry,
      name: 'empty',
      args: '',
      deps: makeMockDeps(),
      parent: makeMockParent(),
    })
    expect(result._tag).toBe('text')
  })

  it('returns timeout error when workflow exceeds meta.timeout', async () => {
    const registry = createWorkflowRegistry()
    const parent = makeMockParent()
    // execute 等待 abort 信号：超时必须真正中止执行，而非仅报错后让
    // 工作流在后台继续烧钱（P0 修复）。
    let aborted = false
    const entry: WorkflowEntry = {
      meta: { name: 'slow', description: 'sleeps', timeout: 0.1 },
      source: 'builtin',
      execute: async () => {
        await new Promise<void>((resolve) => {
          parent.abortController.signal.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve()
            },
            { once: true },
          )
          setTimeout(resolve, 2000)
        })
        return { output: 'should not reach' }
      },
    }
    registry.register(entry)
    const result = await executeWorkflow({
      registry,
      name: 'slow',
      args: '',
      deps: makeMockDeps(),
      parent,
    })
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.message).toContain('timed out')
      expect(result.message).toContain('0.1s')
      expect(result.message).toContain('已中止')
    }
    expect(aborted).toBe(true)
    expect(parent.abortController.signal.aborted).toBe(true)
    expect(parent.status).toEqual({ _tag: 'stopped', reason: 'aborted' })
  })

  // 回归：meta.timeout 是工作流作者声明的秒数，转毫秒后直接进 setTimeout——
  // 声明「超长超时」（如 2^31 秒）时超过 Node 32 位上限，被钳到 1ms：工作流
  // 刚启动就被「超时」中止并谎报时长，且 parent abort 被连带触发（同型：
  // bash timeout / 更新检查间隔的钳制修复）。超限时长应钳到可表示上限。
  it('clamps a huge declared timeout instead of killing the workflow instantly', async () => {
    const registry = createWorkflowRegistry()
    const parent = makeMockParent()
    const entry: WorkflowEntry = {
      meta: { name: 'very-slow', description: 'long timeout', timeout: 2 ** 31 },
      source: 'builtin',
      execute: () => new Promise(() => {}), // 永不完成：只有错误的 1ms timer 才会结束
    }
    registry.register(entry)
    const outcome = await Promise.race([
      executeWorkflow({
        registry,
        name: 'very-slow',
        args: '',
        deps: makeMockDeps(),
        parent,
      }),
      new Promise((resolve) => setTimeout(() => resolve('still-running'), 100)),
    ])
    expect(outcome).toBe('still-running')
    expect(parent.abortController.signal.aborted).toBe(false)
  })
})
