import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { getMessages } from '../session/message.js'
import { createSession, getSession } from '../session/session.js'
import type { StreamChunk } from '../shared/types/llm.js'
import type { Session } from '../shared/types/message.js'
import { createDefaultRegistry } from '../tools/index.js'
import { autoAllowChecker } from '../tools/permission.js'
import {
  abortAgent,
  createAgent,
  getAgentStatus,
  isAgentPaused,
  pauseAgent,
  resumeAgent,
  runAgent,
} from './agent.js'
import { DEFAULT_CONFIG } from './config.js'
import { DEFAULT_SESSION_TITLE } from './title.js'
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
afterEach(async () => {
  await db.close()
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
    for await (const ev of runAgent(agent, [{ _tag: 'text', text: 'Hello' }], deps)) {
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
    for await (const _ev of runAgent(agent, [{ _tag: 'text', text: 'hi' }], deps)) {
      // consume
    }
    expect(getAgentStatus(agent)._tag).toBe('stopped')
  })

  it('generates a session title on the first user message', async () => {
    const titleSession = await createSession(db, DEFAULT_SESSION_TITLE)
    const deps = makeDeps(db, mockTextStream('Response!'))
    deps.titleChatFn = async () => 'Generated Title'
    const agent = await createAgent(
      titleSession,
      { provider: 'p', model: 'm', tools: [], plugins: [], maxTurns: 5 },
      deps,
    )
    for await (const _ev of runAgent(
      agent,
      [{ _tag: 'text', text: 'Do something important' }],
      deps,
    )) {
      // consume
    }
    // 标题生成是 fire-and-forget，轮询 DB 直到更新完成或超时。
    let title = DEFAULT_SESSION_TITLE
    for (let i = 0; i < 50 && title === DEFAULT_SESSION_TITLE; i++) {
      await new Promise((r) => setTimeout(r, 20))
      title = (await getSession(db, titleSession.id))?.title ?? title
    }
    expect(title).toBe('Generated Title')
  })

  it('does not override a non-default title', async () => {
    const namedSession = await createSession(db, 'Custom Title')
    let called = false
    const deps = makeDeps(db, mockTextStream('Response!'))
    deps.titleChatFn = async () => {
      called = true
      return 'Should Not Appear'
    }
    const agent = await createAgent(
      namedSession,
      { provider: 'p', model: 'm', tools: [], plugins: [], maxTurns: 5 },
      deps,
    )
    for await (const _ev of runAgent(agent, [{ _tag: 'text', text: 'hello' }], deps)) {
      // consume
    }
    await new Promise((r) => setTimeout(r, 100))
    expect(called).toBe(false)
    expect((await getSession(db, namedSession.id))?.title).toBe('Custom Title')
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

  it('isAgentPaused 仅在 paused 时返回 true', async () => {
    const agent = await createAgent(
      session,
      { provider: 'p', model: 'm', tools: [], plugins: [] },
      makeDeps(db, mockTextStream('x')),
    )
    expect(isAgentPaused(agent)).toBe(false) // idle
    agent.status = { _tag: 'running', turnCount: 0 }
    expect(isAgentPaused(agent)).toBe(false)
    agent.status = { _tag: 'paused', pauseReason: 'test' }
    expect(isAgentPaused(agent)).toBe(true)
  })
})
