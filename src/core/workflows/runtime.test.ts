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
    status: { _tag: 'idle' },
    tools: [],
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
})
