import { describe, expect, it } from 'vitest'
import type { AgentState } from '../shared/types/agent.js'
import type { Session } from '../shared/types/message.js'
import { clearSteering, drainSteering, injectSteering } from './steering.js'

function makeState(): AgentState {
  const session: Session = {
    id: 's1',
    title: 't',
    parentId: null,
    projectId: null,
    branchPoint: null,
    metadata: {},
    agentType: null,
    worktreePath: null,
    source: null,
    deletedAt: null,
    createdAt: 0,
    updatedAt: 0,
  }
  return {
    id: 'a1',
    session,
    messages: [],
    tools: [],
    config: { provider: 'p', model: 'm', tools: [], plugins: [] },
    status: { _tag: 'idle' },
    abortController: new AbortController(),
    steeringQueue: [],
    segments: [],
    tokenBudget: { total: 0, reserved: 0, available: 0, historyBudget: 0, used: 0, keepRecent: 0 },
    calibrationFactor: 1.0,
    todoPhases: [],
  }
}

describe('steering queue', () => {
  it('injectSteering adds message to queue', () => {
    const state = makeState()
    injectSteering(state, 'stop using globals')
    expect(state.steeringQueue).toEqual(['stop using globals'])
  })

  it('injectSteering appends multiple messages in order', () => {
    const state = makeState()
    injectSteering(state, 'first')
    injectSteering(state, 'second')
    expect(state.steeringQueue).toEqual(['first', 'second'])
  })

  it('drainSteering returns all messages and clears queue', () => {
    const state = makeState()
    injectSteering(state, 'a')
    injectSteering(state, 'b')
    const drained = drainSteering(state)
    expect(drained).toEqual(['a', 'b'])
    expect(state.steeringQueue).toEqual([])
  })

  it('drainSteering returns empty array when queue is empty', () => {
    const state = makeState()
    expect(drainSteering(state)).toEqual([])
  })

  it('clearSteering empties the queue', () => {
    const state = makeState()
    injectSteering(state, 'x')
    clearSteering(state)
    expect(state.steeringQueue).toEqual([])
  })
})
