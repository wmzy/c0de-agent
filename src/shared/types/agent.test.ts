import { describe, expect, it } from 'vitest'
import type {
  AgentConfig,
  AgentError,
  AgentEvent,
  AgentState,
  AgentStatus,
  TokenBudget,
} from './agent.js'

describe('AgentError', () => {
  it('creates an aborted error', () => {
    const error: AgentError = { _tag: 'aborted' }
    expect(error._tag).toBe('aborted')
  })

  it('creates a max_turns error', () => {
    const error: AgentError = { _tag: 'max_turns', maxTurns: 50 }
    expect(error._tag).toBe('max_turns')
  })

  it('creates a provider error', () => {
    const error: AgentError = {
      _tag: 'provider',
      message: 'Rate limited',
      retryable: true,
    }
    expect(error._tag).toBe('provider')
  })
})

describe('AgentStatus', () => {
  it('creates idle status', () => {
    const status: AgentStatus = { _tag: 'idle' }
    expect(status._tag).toBe('idle')
  })

  it('creates running status with turn count', () => {
    const status: AgentStatus = { _tag: 'running', turnCount: 3 }
    if (status._tag === 'running') {
      expect(status.turnCount).toBe(3)
    }
  })

  it('creates paused status', () => {
    const status: AgentStatus = {
      _tag: 'paused',
      pauseReason: 'User requested pause',
    }
    if (status._tag === 'paused') {
      expect(status.pauseReason).toBe('User requested pause')
    }
  })

  it('creates stopped status', () => {
    const status: AgentStatus = { _tag: 'stopped', reason: 'completed' }
    if (status._tag === 'stopped') {
      expect(status.reason).toBe('completed')
    }
  })
})

describe('AgentConfig', () => {
  it('creates a minimal config', () => {
    const config: AgentConfig = {
      provider: 'openai',
      model: 'gpt-4.1',
      tools: ['read', 'write', 'bash'],
      plugins: [],
    }
    expect(config.model).toBe('gpt-4.1')
  })
})

describe('TokenBudget', () => {
  it('creates a token budget', () => {
    const budget: TokenBudget = {
      total: 128_000,
      reserved: 25_600,
      available: 102_400,
      historyBudget: 76_800,
      used: 50_000,
      keepRecent: 10,
    }
    expect(budget.available).toBe(102_400)
  })
})

describe('AgentEvent', () => {
  it('creates a text_delta event', () => {
    const event: AgentEvent = { _tag: 'text_delta', text: 'hello' }
    expect(event._tag).toBe('text_delta')
  })

  it('creates a tool_call_start event', () => {
    const event: AgentEvent = {
      _tag: 'tool_call_start',
      id: 'tc-1',
      tool: 'read',
      input: { path: 'a.ts' },
    }
    expect(event._tag).toBe('tool_call_start')
  })

  it('creates a usage event', () => {
    const event: AgentEvent = {
      _tag: 'usage',
      input: 1500,
      output: 200,
    }
    if (event._tag === 'usage') {
      expect(event.input).toBe(1500)
    }
  })

  it('creates a permission_required event', () => {
    const event: AgentEvent = {
      _tag: 'permission_required',
      toolCallId: 'tc-1',
      tool: 'bash',
      input: { command: 'rm -rf /' },
    }
    expect(event._tag).toBe('permission_required')
  })

  it('creates a done event', () => {
    const event: AgentEvent = { _tag: 'done' }
    expect(event._tag).toBe('done')
  })
})

describe('AgentState', () => {
  it('creates a minimal agent state', () => {
    const state: AgentState = {
      id: 'agent-1',
      session: {
        id: 'sess-1',
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
      config: {
        provider: 'openai',
        model: 'gpt-4.1',
        tools: [],
        plugins: [],
      },
      status: { _tag: 'idle' },
      abortController: new AbortController(),
      steeringQueue: [],
      segments: [],
      tokenBudget: {
        total: 128_000,
        reserved: 0,
        available: 128_000,
        historyBudget: 76_800,
        used: 0,
        keepRecent: 10,
      },
      calibrationFactor: 1.0,
    }
    expect(state.status._tag).toBe('idle')
    expect(state.messages).toHaveLength(0)
  })
})
