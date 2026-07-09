import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { fromDirectory } from '../../project/index.js'
import type { Session } from '../../shared/types/message.js'
import { createServerContext } from '../context.js'
import type { APIErrorBody } from '../types.js'
import { createSessionRoute } from './session.js'

let dbHandle: DB | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  const ctx = createServerContext({ db, llmRegistry: createRegistry() })
  const app = createSessionRoute(ctx)
  return { app, ctx, db }
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

  it('GET /:id/status 无活跃 run 返回 idle', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Status' }),
    })
    const created = (await createRes.json()) as Session
    const res = await app.request(`/${created.id}/status`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { _tag: string }
    expect(body._tag).toBe('idle')
  })

  it('GET /:id/llm-details/:callId 子端点已移除（段内 call 由前端从段取）', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'LLMSegment' }),
    })
    const created = (await createRes.json()) as Session
    // /:callId 子端点已删除；/llm-details/nope 不匹配任何路由 → 404
    const res = await app.request(`/${created.id}/llm-details/nope`)
    expect(res.status).toBe(404)
  })

  it('POST /:id/compact 不存在的会话 → 404', async () => {
    const { app } = await setup()
    const res = await app.request('/nonexistent/compact', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('POST /:id/compact 消息过少的会话 → 200 compacted:false（不调 LLM）', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Compact' }),
    })
    const created = (await createRes.json()) as Session
    const res = await app.request(`/${created.id}/compact`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { compacted: boolean; reason?: string }
    expect(body.compacted).toBe(false)
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

  it('POST / with directory associates project', async () => {
    const { app } = await setup()
    const dir = mkdtempSync(join(tmpdir(), 'route-'))
    try {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'S', directory: dir }),
      })
      expect(res.status).toBe(201)
      const session = (await res.json()) as Session
      expect(session.projectId).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('POST /:id/shake/preview 返回可 shake 区域', async () => {
    const { app, db } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Shake' }),
    })
    const created = (await createRes.json()) as Session

    const { appendMessage } = await import('../../session/message.js')
    await appendMessage(db, created.id, {
      role: 'tool',
      content: [
        {
          _tag: 'tool_result',
          id: 'call-1',
          tool: 'bash',
          output: { _tag: 'success', output: 'x'.repeat(5000) },
        },
      ],
    })

    const res = await app.request(`/${created.id}/shake/preview`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { regions: Array<{ kind: string; tokens: number }> }
    expect(body.regions.length).toBeGreaterThan(0)
    expect(body.regions.some((r) => r.kind === 'toolResult')).toBe(true)
  })

  it('POST /:id/shake/preview 不存在的会话 → 404', async () => {
    const { app } = await setup()
    const res = await app.request('/nonexistent/shake/preview', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('POST /:id/shake/apply 归档并替换内容', async () => {
    const { app, db } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ShakeApply' }),
    })
    const created = (await createRes.json()) as Session

    const { appendMessage } = await import('../../session/message.js')
    await appendMessage(db, created.id, {
      role: 'tool',
      content: [
        {
          _tag: 'tool_result',
          id: 'call-1',
          tool: 'bash',
          output: { _tag: 'success', output: 'x'.repeat(5000) },
        },
      ],
    })

    // preview 拿 regionId
    const previewRes = await app.request(`/${created.id}/shake/preview`, { method: 'POST' })
    const previewBody = (await previewRes.json()) as { regions: Array<{ id: string }> }
    const firstRegion = previewBody.regions[0]
    if (!firstRegion) throw new Error('preview returned no regions')
    const regionId = firstRegion.id

    // apply
    const applyRes = await app.request(`/${created.id}/shake/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regionIds: [regionId] }),
    })
    expect(applyRes.status).toBe(200)
    const applyBody = (await applyRes.json()) as { shaken: number; archiveId: string }
    expect(applyBody.shaken).toBe(1)
    expect(applyBody.archiveId).toBeTruthy()

    // 再次 preview：已 shaken 的不出现
    const previewRes2 = await app.request(`/${created.id}/shake/preview`, { method: 'POST' })
    const previewBody2 = (await previewRes2.json()) as { regions: unknown[] }
    expect(previewBody2.regions).toHaveLength(0)
  })

  it('POST /:id/shake/apply regionIds 不匹配 → 400', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Shake400' }),
    })
    const created = (await createRes.json()) as Session

    const res = await app.request(`/${created.id}/shake/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regionIds: ['nonexistent-id'] }),
    })
    expect(res.status).toBe(400)
  })

  it('GET / filters by projectId', async () => {
    const { app, db } = await setup()
    const dir = mkdtempSync(join(tmpdir(), 'route2-'))
    try {
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'WithProject', directory: dir }),
      })
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'NoProject' }),
      })
      const project = await fromDirectory(db, dir)
      const res = await app.request(`/?projectId=${project.id}`)
      const sessions = (await res.json()) as Session[]
      expect(sessions.every((s) => s.projectId === project.id)).toBe(true)
      expect(sessions.some((s) => s.title === 'WithProject')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
