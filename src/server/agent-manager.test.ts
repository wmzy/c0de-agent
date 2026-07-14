// src/server/agent-manager.test.ts
import { describe, expect, it } from 'vitest'
import { abortAgent, injectSteering, pauseAgent, resumeAgent } from '../core/index.js'
import type { AgentDependencies, AgentState } from '../core/types.js'
import { createAgentManager } from './agent-manager.js'

function mockState(sessionId: string): AgentState {
  return {
    id: 'agent-1',
    session: {
      id: sessionId,
      title: 'Test',
      parentId: null,
      projectId: null,
      branchPoint: null,
      metadata: {},
      agentType: null,
      worktreePath: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    tools: [],
    config: { provider: 'test', model: 'test', tools: [], plugins: [] },
    status: { _tag: 'running', turnCount: 0 },
    abortController: new AbortController(),
    steeringQueue: [],
    segments: [],
    tokenBudget: {
      total: 1000,
      reserved: 200,
      available: 800,
      historyBudget: 600,
      used: 0,
      keepRecent: 100,
    },
    calibrationFactor: 1.0,
    todoPhases: [],
  }
}

describe('AgentManager', () => {
  it('register 和 get 跟踪活跃 run', () => {
    const mgr = createAgentManager()
    const state = mockState('s1')
    const deps = {} as AgentDependencies

    mgr.register({ sessionId: 's1', state, deps })

    expect(mgr.get('s1')?.state).toBe(state)
    expect(mgr.size()).toBe(1)
  })

  it('unregister 移除 run', () => {
    const mgr = createAgentManager()
    const state = mockState('s1')

    mgr.register({
      sessionId: 's1',
      state,
      deps: {} as AgentDependencies,
    })
    mgr.unregister('s1')

    expect(mgr.get('s1')).toBeUndefined()
    expect(mgr.size()).toBe(0)
  })

  it('get 不存在的 sessionId 返回 undefined', () => {
    const mgr = createAgentManager()
    expect(mgr.get('nonexistent')).toBeUndefined()
  })

  it('abort 调用 abortAgent 并返回 true', () => {
    const mgr = createAgentManager()
    const state = mockState('s1')

    mgr.register({
      sessionId: 's1',
      state,
      deps: {} as AgentDependencies,
    })

    const ok = mgr.abort('s1')
    expect(ok).toBe(true)
    expect(state.abortController.signal.aborted).toBe(true)
    expect(state.status._tag).toBe('stopped')
  })

  it('abort 不存在的 session 返回 false', () => {
    const mgr = createAgentManager()
    expect(mgr.abort('nope')).toBe(false)
  })

  it('pause 调用 pauseAgent', () => {
    const mgr = createAgentManager()
    const state = mockState('s1')

    mgr.register({
      sessionId: 's1',
      state,
      deps: {} as AgentDependencies,
    })

    const ok = mgr.pause('s1')
    expect(ok).toBe(true)
    expect(state.status._tag).toBe('paused')
  })

  it('resume 调用 resumeAgent', () => {
    const mgr = createAgentManager()
    const state = mockState('s1')

    mgr.register({
      sessionId: 's1',
      state,
      deps: {} as AgentDependencies,
    })

    mgr.pause('s1')
    expect(state.status._tag).toBe('paused')

    const ok = mgr.resume('s1')
    expect(ok).toBe(true)
    expect(state.status._tag).toBe('running')
  })

  it('steer 注入 steering 消息', () => {
    const mgr = createAgentManager()
    const state = mockState('s1')

    mgr.register({
      sessionId: 's1',
      state,
      deps: {} as AgentDependencies,
    })

    const ok = mgr.steer('s1', 'Be more concise')
    expect(ok).toBe(true)
    expect(state.steeringQueue).toContain('Be more concise')
  })

  it('register 覆盖相同 sessionId 的旧 run', () => {
    const mgr = createAgentManager()
    const state1 = mockState('s1')
    const state2 = mockState('s1')

    mgr.register({
      sessionId: 's1',
      state: state1,
      deps: {} as AgentDependencies,
    })
    mgr.register({
      sessionId: 's1',
      state: state2,
      deps: {} as AgentDependencies,
    })

    expect(mgr.size()).toBe(1)
    expect(mgr.get('s1')?.state).toBe(state2)
  })

  it('dispose abort 所有活跃 run 并清空', () => {
    const mgr = createAgentManager()
    const state1 = mockState('s1')
    const state2 = mockState('s2')

    mgr.register({
      sessionId: 's1',
      state: state1,
      deps: {} as AgentDependencies,
    })
    mgr.register({
      sessionId: 's2',
      state: state2,
      deps: {} as AgentDependencies,
    })

    expect(mgr.size()).toBe(2)

    mgr.dispose()

    // 所有 run 被 abort
    expect(state1.abortController.signal.aborted).toBe(true)
    expect(state2.abortController.signal.aborted).toBe(true)
    // runs Map 清空
    expect(mgr.size()).toBe(0)
    expect(mgr.get('s1')).toBeUndefined()
    expect(mgr.get('s2')).toBeUndefined()
  })

  // 注意：abortAgent/pauseAgent/resumeAgent/injectSteering 已从 core 导入
  // 此处仅验证 mockState 的状态正确性，不实际调用 core 函数
  void abortAgent
  void pauseAgent
  void resumeAgent
  void injectSteering
})
