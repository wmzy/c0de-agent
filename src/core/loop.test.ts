import { beforeEach, describe, expect, it } from 'vitest'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { appendMessage, createSession, getMessages } from '../session/index.js'
import type { AgentEvent, AgentState } from '../shared/types/agent.js'
import type { StreamChunk } from '../shared/types/llm.js'
import type { Message, Session } from '../shared/types/message.js'
import { createDefaultRegistry } from '../tools/index.js'
import { autoAllowChecker } from '../tools/permission.js'
import { DEFAULT_CONFIG } from './config.js'
import type { LoopDeps } from './loop.js'
import { agentLoop } from './loop.js'

function mockTextStream(text: string): AsyncGenerator<StreamChunk> {
  async function* gen() {
    yield { _tag: 'text', text } as const
    yield { _tag: 'done' } as const
  }
  return gen()
}

let mockTurn = 0
function mockToolThenTextStream(): AsyncGenerator<StreamChunk> {
  const turn = mockTurn
  mockTurn++
  async function* gen() {
    if (turn === 0) {
      yield { _tag: 'tool_call_start', id: 'tc1', name: 'read' } as const
      yield {
        _tag: 'tool_call_end',
        id: 'tc1',
        argumentsFinal: JSON.stringify({ path: 'package.json' }),
      } as const
      yield { _tag: 'done' } as const
    } else {
      yield { _tag: 'text', text: 'Done reading.' } as const
      yield { _tag: 'done' } as const
    }
  }
  return gen()
}

function makeMockDeps(db: LoopDeps['db'], streamFn: () => AsyncGenerator<StreamChunk>): LoopDeps {
  return {
    db,
    llmRegistry: {} as LoopDeps['llmRegistry'],
    toolRegistry: createDefaultRegistry(),
    permission: autoAllowChecker,
    config: DEFAULT_CONFIG,
    cwd: process.cwd(),
    chatStream: streamFn as unknown as LoopDeps['chatStream'],
  }
}

function makeState(session: Session, messages: Message[]): AgentState {
  return {
    id: 'agent1',
    session,
    messages,
    tools: [],
    config: {
      provider: 'mock',
      model: 'mock',
      tools: ['read'],
      plugins: [],
      maxTurns: 10,
    },
    status: { _tag: 'idle' },
    abortController: new AbortController(),
    steeringQueue: [],
    llmDetails: [],
    tokenBudget: {
      total: 100_000,
      reserved: 20_000,
      available: 80_000,
      used: 0,
      keepRecent: 10_000,
    },
  }
}

let db: Awaited<ReturnType<typeof createDB>>
let session: Session

beforeEach(async () => {
  mockTurn = 0
  db = await createDB({ driver: 'pglite' })
  await migrateDB(db)
  session = await createSession(db, 'test')
  await appendMessage(db, session.id, {
    role: 'user',
    content: [{ _tag: 'text', text: 'Hello' }],
  })
})

describe('agentLoop', () => {
  it('emits text_delta and done for a simple text response', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockTextStream('Hello back!'))
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'text_delta' && e.text === 'Hello back!')).toBe(true)
    expect(events.some((e) => e._tag === 'done')).toBe(true)
  })

  it('emits tool_call events and executes the tool', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockToolThenTextStream())
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'tool_call_start')).toBe(true)
    expect(events.some((e) => e._tag === 'tool_call_end')).toBe(true)
    expect(events.some((e) => e._tag === 'text_delta')).toBe(true)
    expect(events.some((e) => e._tag === 'done')).toBe(true)
  })

  it('stops on abort', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockTextStream('Hello'))
    state.abortController.abort()
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'error')).toBe(true)
  })

  it('respects maxTurns', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    state.config.maxTurns = 1
    const deps = makeMockDeps(db, () => mockToolThenTextStream())
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'error' && e.error._tag === 'max_turns')).toBe(true)
  })

  it('drains steering messages before LLM call', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    state.steeringQueue.push('Be extra careful')
    const deps = makeMockDeps(db, () => mockTextStream('ok'))
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    expect(state.steeringQueue).toEqual([])
  })
})
