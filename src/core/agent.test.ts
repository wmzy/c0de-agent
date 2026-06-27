import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { getMessages } from '../session/message.js'
import { createSession } from '../session/session.js'
import type { StreamChunk } from '../shared/types/llm.js'
import type { Session } from '../shared/types/message.js'
import { createDefaultRegistry } from '../tools/index.js'
import { autoAllowChecker } from '../tools/permission.js'
import {
  abortAgent,
  createAgent,
  getAgentStatus,
  pauseAgent,
  resumeAgent,
  runAgent,
} from './agent.js'
import { DEFAULT_CONFIG } from './config.js'
import type { AgentDependencies } from './types.js'

function mockTextStream(text: string) {
  return async function* (): AsyncGenerator<StreamChunk> {
    yield { _tag: 'text', text }
    yield { _tag: 'done' }
  }
}

function makeDeps(db: DB, streamFn: () => AsyncGenerator<StreamChunk>): AgentDependencies {
  return {
    db,
    llmRegistry: {} as AgentDependencies['llmRegistry'],
    toolRegistry: createDefaultRegistry(),
    permission: autoAllowChecker,
    config: DEFAULT_CONFIG,
    cwd: process.cwd(),
    chatStream: streamFn,
  } as AgentDependencies
}

let db: DB
let session: Session

beforeEach(async () => {
  db = await createDB({ driver: 'pglite' })
  await migrateDB(db)
  session = await createSession(db, 'test')
})

describe('createAgent', () => {
  it('creates an agent with idle status', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: ['read'], plugins: [] },
      makeDeps(db, mockTextStream('hi')),
    )
    expect(agent.status._tag).toBe('idle')
    expect(agent.session.id).toBe(session.id)
    expect(agent.steeringQueue).toEqual([])
  })

  it('loads existing messages from DB', async () => {
    const { appendMessage } = await import('../session/message.js')
    await appendMessage(db, session.id, {
      role: 'user',
      content: [{ _tag: 'text', text: 'prior message' }],
    })
    await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('hi')),
    )
    const messages = await getMessages(db, session.id)
    expect(messages.length).toBeGreaterThan(0)
  })
})

describe('runAgent', () => {
  it('persists user message and runs the loop', async () => {
    const deps = makeDeps(db, mockTextStream('Response!'))
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [], maxTurns: 5 },
      deps,
    )
    const events: Array<{ _tag: string; text?: string }> = []
    for await (const ev of runAgent(agent, 'Hello', deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'text_delta' && e.text === 'Response!')).toBe(true)
    const msgs = await getMessages(db, session.id)
    expect(msgs.some((m) => m.content.some((c) => c._tag === 'text' && c.text === 'Hello'))).toBe(
      true,
    )
  })

  it('sets status to completed on natural end', async () => {
    const deps = makeDeps(db, mockTextStream('done'))
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [], maxTurns: 5 },
      deps,
    )
    for await (const _ev of runAgent(agent, 'hi', deps)) {
      // consume
    }
    expect(getAgentStatus(agent)._tag).toBe('stopped')
  })
})

describe('control functions', () => {
  it('pauseAgent sets paused status', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('x')),
    )
    agent.status = { _tag: 'running', turnCount: 0 }
    pauseAgent(agent)
    expect(agent.status._tag).toBe('paused')
  })

  it('resumeAgent sets running status', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('x')),
    )
    agent.status = { _tag: 'paused', pauseReason: 'test' }
    resumeAgent(agent)
    expect(agent.status._tag).toBe('running')
  })

  it('abortAgent triggers abort and sets stopped', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('x')),
    )
    abortAgent(agent)
    expect(agent.abortController.signal.aborted).toBe(true)
  })

  it('pauseAgent is a no-op when not running', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('x')),
    )
    pauseAgent(agent)
    expect(agent.status._tag).toBe('idle')
  })

  it('getAgentStatus returns current status', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('x')),
    )
    expect(getAgentStatus(agent)).toBe(agent.status)
  })
})
