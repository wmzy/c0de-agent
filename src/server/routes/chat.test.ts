import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { createSession } from '../../session/session.js'
import type { StreamChunk } from '../../shared/types/llm.js'
import { createServerContext } from '../context.js'
import { createChatRoute, resolveAgentCwd } from './chat.js'
import { fromDirectory } from '../../project/project.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 模拟 chatStream：返回简单的文本 + done。 */
function mockChatStream(): AsyncGenerator<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    yield { _tag: 'text', text: 'Hello' }
    yield { _tag: 'text', text: ' world' }
    yield { _tag: 'done' }
  })()
}

let dbHandle: DB | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  const session = await createSession(db, 'Test')
  const ctx = createServerContext({
    db,
    llmRegistry: createRegistry(),
    chatStream: mockChatStream,
  })
  const app = createChatRoute(ctx)
  return { app, ctx, sessionId: session.id }
}

/** 从 SSE 响应中解析事件。 */
function parseSSEEvents(text: string): { event: string; data: string }[] {
  const events: { event: string; data: string }[] = []
  const blocks = text.split('\n\n')
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim())
    if (lines.length === 0) continue
    const eventLine = lines.find((l) => l.startsWith('event:'))
    const dataLine = lines.find((l) => l.startsWith('data:'))
    if (eventLine && dataLine) {
      events.push({
        event: eventLine.slice(6).trim(),
        data: dataLine.slice(5).trim(),
      })
    }
  }
  return events
}

describe('chat route (SSE)', () => {
  it('POST / without sessionId returns 400', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST / without message returns 400', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    expect(res.status).toBe(400)
  })

  it('POST / nonexistent session returns 404', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nonexistent', message: 'hi' }),
    })
    expect(res.status).toBe(404)
  })

  it('POST / streams agent events', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'Hello' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const text = await res.text()
    const events = parseSSEEvents(text)

    const types = events.map((e) => e.event)
    expect(types).toContain('text_delta')
    expect(types).toContain('done')
  })

  it('POST / text_delta events contain text content', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'Hi' }),
    })
    const text = await res.text()
    const events = parseSSEEvents(text)
    const textDeltas = events.filter((e) => e.event === 'text_delta')
    const combinedText = textDeltas.map((e) => JSON.parse(e.data).text as string).join('')
    expect(combinedText).toContain('Hello')
  })

  it('POST / unregisters from agentManager after completion', async () => {
    const { app, ctx, sessionId } = await setup()
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'Hi' }),
    })
    expect(ctx.agentManager.get(sessionId)).toBeUndefined()
  })

  it('resolveAgentCwd: returns worktree when session has project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwd-'))
    try {
      const db = await createDB({ driver: 'pglite' })
      dbHandle = db
      await migrateDB(db)
      const project = await fromDirectory(db, dir)
      const ctx = createServerContext({ db, llmRegistry: createRegistry(), chatStream: mockChatStream })
      const cwd = await resolveAgentCwd(ctx, { projectId: project.id })
      expect(cwd).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveAgentCwd: falls back to ctx.cwd when no project', async () => {
    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), chatStream: mockChatStream, cwd: '/some/base' })
    const cwd = await resolveAgentCwd(ctx, { projectId: null })
    expect(cwd).toBe('/some/base')
  })
})

describe('chat route (control endpoints)', () => {
  it('POST /abort without active run returns aborted: false', async () => {
    const { app } = await setup()
    const res = await app.request('/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { aborted: boolean }
    expect(body.aborted).toBe(false)
  })

  it('POST /pause without active run returns paused: false', async () => {
    const { app } = await setup()
    const res = await app.request('/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { paused: boolean }).paused).toBe(false)
  })

  it('POST /resume without active run returns resumed: false', async () => {
    const { app } = await setup()
    const res = await app.request('/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { resumed: boolean }).resumed).toBe(false)
  })

  it('POST /steer without active run returns steered: false', async () => {
    const { app } = await setup()
    const res = await app.request('/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope', message: 'msg' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { steered: boolean }).steered).toBe(false)
  })
})
