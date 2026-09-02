// src/server/routes/terminal.test.ts

import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { createTerminalRoute } from './terminal.js'

function setup() {
  const ctx = createServerContext({
    db: { close: async () => {} } as never,
    llmRegistry: createRegistry(),
    cwd: tmpdir(),
  })
  const app = createTerminalRoute(ctx)
  return { app, ctx }
}

describe('terminal route', () => {
  const createdIds: string[] = []

  afterEach(() => {
    // 清理在测试中创建的 PTY
  })

  it('GET / returns empty terminal list initially', async () => {
    const { app } = setup()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.terminals).toEqual([])
  })

  it('POST / creates a new PTY session', async () => {
    const { app } = setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toMatch(/^pty_/)
    expect(body.pid).toBeGreaterThan(0)
    expect(body.shell).toBeTruthy()
    createdIds.push(body.id as string)
  })

  it('GET /:id returns the created PTY info', async () => {
    const { app } = setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const created = (await createRes.json()) as { id: string }

    const res = await app.request(`/${created.id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe(created.id)
  })

  it('GET /:id returns 404 for unknown id', async () => {
    const { app } = setup()
    const res = await app.request('/nonexistent')
    expect(res.status).toBe(404)
  })

  it('PUT /:id resizes the terminal', async () => {
    const { app } = setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const created = (await createRes.json()) as { id: string }

    const res = await app.request(`/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols: 120, rows: 40 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.cols).toBe(120)
    expect(body.rows).toBe(40)
  })

  it('DELETE /:id terminates the terminal', async () => {
    const { app } = setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const created = (await createRes.json()) as { id: string }

    const res = await app.request(`/${created.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)

    // 再 GET 应 404
    const getRes = await app.request(`/${created.id}`)
    expect(getRes.status).toBe(404)
  })

  it('DELETE /:id returns 404 for unknown id', async () => {
    const { app } = setup()
    const res = await app.request('/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('POST / with projectId stores and returns it', async () => {
    const { app, ctx } = setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-xyz' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toMatch(/^pty_/)
    expect(body.projectId).toBe('proj-xyz')
    ctx.ptyManager.kill(body.id as string)
  })

  it('POST / without projectId returns undefined projectId', async () => {
    const { app, ctx } = setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.projectId).toBeUndefined()
    ctx.ptyManager.kill(body.id as string)
  })
})
