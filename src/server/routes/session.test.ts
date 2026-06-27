import { describe, expect, it } from 'vitest'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import type { Session } from '../../shared/types/message.js'
import { createServerContext } from '../context.js'
import type { APIErrorBody } from '../types.js'
import { createSessionRoute } from './session.js'

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  await migrateDB(db)
  const ctx = createServerContext({ db, llmRegistry: createRegistry() })
  const app = createSessionRoute(ctx)
  return { app, ctx }
}

describe('session route', () => {
  it('POST / creates session', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My Session' }),
    })
    expect(res.status).toBe(201)
    const session = (await res.json()) as Session
    expect(session.title).toBe('My Session')
    expect(session.id).toBeDefined()
    expect(session.parentId).toBeNull()
  })

  it('POST / without title uses default', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(201)
    const session = (await res.json()) as Session
    expect(session.title).toBe('New Session')
  })

  it('GET / lists all sessions', async () => {
    const { app } = await setup()
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'S1' }),
    })
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'S2' }),
    })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const sessions = (await res.json()) as Session[]
    expect(sessions).toHaveLength(2)
  })

  it('GET /:id returns session detail', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Detail' }),
    })
    const created = (await createRes.json()) as Session
    const res = await app.request(`/${created.id}`)
    expect(res.status).toBe(200)
    const session = (await res.json()) as Session
    expect(session.id).toBe(created.id)
  })

  it('GET /:id not found returns 404', async () => {
    const { app } = await setup()
    const res = await app.request('/nonexistent')
    expect(res.status).toBe(404)
    const body = (await res.json()) as APIErrorBody
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('DELETE /:id deletes session', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ToDelete' }),
    })
    const created = (await createRes.json()) as Session
    const delRes = await app.request(`/${created.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(204)
    const getRes = await app.request(`/${created.id}`)
    expect(getRes.status).toBe(404)
  })

  it('GET /:id/messages returns message list', async () => {
    const { app, ctx } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Msg' }),
    })
    const created = (await createRes.json()) as Session
    await ctx.db.db.insert((await import('../../db/schema.js')).sessionEntries).values({
      sessionId: created.id,
      tag: 'message',
      role: 'user',
      content: [{ _tag: 'text', text: 'hello' }],
    })
    const res = await app.request(`/${created.id}/messages`)
    expect(res.status).toBe(200)
    const messages = (await res.json()) as Array<{ role: string }>
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('user')
  })

  it('POST /:id/fork branches session', async () => {
    const { app, ctx } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Original' }),
    })
    const created = (await createRes.json()) as Session
    await ctx.db.db.insert((await import('../../db/schema.js')).sessionEntries).values({
      sessionId: created.id,
      tag: 'message',
      role: 'user',
      content: [{ _tag: 'text', text: 'msg1' }],
    })
    const forkRes = await app.request(`/${created.id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIndex: 0 }),
    })
    expect(forkRes.status).toBe(201)
    const forked = (await forkRes.json()) as Session
    expect(forked.parentId).toBe(created.id)
  })

  it('GET /tree returns session tree', async () => {
    const { app } = await setup()
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Root' }),
    })
    const res = await app.request('/tree')
    expect(res.status).toBe(200)
    const tree = (await res.json()) as unknown[]
    expect(Array.isArray(tree)).toBe(true)
    expect(tree.length).toBeGreaterThan(0)
  })

  it('GET /:id/llm-details returns empty array for no active run', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Detail' }),
    })
    const created = (await createRes.json()) as Session
    const res = await app.request(`/${created.id}/llm-details`)
    expect(res.status).toBe(200)
    const details = (await res.json()) as unknown[]
    expect(Array.isArray(details)).toBe(true)
  })

  it('GET /:id/branches returns branches', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Main' }),
    })
    const created = (await createRes.json()) as Session
    const res = await app.request(`/${created.id}/branches`)
    expect(res.status).toBe(200)
    const branches = (await res.json()) as unknown[]
    expect(Array.isArray(branches)).toBe(true)
  })
})
