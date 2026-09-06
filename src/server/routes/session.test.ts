import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { projects, sessionEntries, sessions } from '../../db/schema.js'
import { createRegistry } from '../../llm/registry.js'
import { fromDirectory } from '../../project/index.js'
import { archiveOriginalEntries } from '../../session/archive.js'
import {
  createSession,
  getSession,
  listDeletedSessions,
  updateSessionLastRun,
} from '../../session/session.js'
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

  it('DELETE /:id soft-deletes session (回收站保留)', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ToDelete' }),
    })
    const created = (await createRes.json()) as Session
    const delRes = await app.request(`/${created.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(204)
    // 软删除：详情仍可读，但活跃列表与回收站分开
    const getRes = await app.request(`/${created.id}`)
    expect(getRes.status).toBe(200)
    const deletedRes = await app.request('/deleted')
    expect(deletedRes.status).toBe(200)
    const deleted = (await deletedRes.json()) as Session[]
    expect(deleted.some((s) => s.id === created.id)).toBe(true)

    // 恢复：回到活跃列表
    const restoreRes = await app.request(`/${created.id}/restore`, { method: 'POST' })
    expect(restoreRes.status).toBe(200)
    const afterRestore = await app.request('/deleted')
    const after = (await afterRestore.json()) as Session[]
    expect(after.some((s) => s.id === created.id)).toBe(false)
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

  it('POST /:id/fork 分支点越界 → 400 BRANCH_POINT_OUT_OF_RANGE（区别于会话不存在 404）', async () => {
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
    // 会话存在但 messageIndex 超出条目数 → 400 透出越界语义（归 404 会误导排查）
    const res = await app.request(`/${created.id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIndex: 99 }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as APIErrorBody
    expect(body.error.code).toBe('BRANCH_POINT_OUT_OF_RANGE')
    expect(body.error.message).toContain('99')
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

  it('GET /:id/status lastRun=paused 且无活跃 run → interrupted（重启后 run 内存态已丢）', async () => {
    const { app, ctx } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Paused' }),
    })
    const created = (await createRes.json()) as Session
    // 直接写 DB：lastRun.status='paused'（模拟热更新前暂停、进程已退出的遗留状态）
    await updateSessionLastRun(ctx.db, created.id, {
      status: 'paused',
      provider: 'p',
      model: 'm',
      startedAt: Date.now(),
    })
    const res = await app.request(`/${created.id}/status`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { _tag: string }
    expect(body._tag).toBe('interrupted')
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

  it('POST /:id/restore 会话项目已删除时按 worktreePath 重建归属', async () => {
    const { app, ctx } = await setup()
    const dir = mkdtempSync(join(tmpdir(), 'rebind-'))
    try {
      // 会话绑定项目 + 记录 worktreePath（模拟项目删除前的落盘）
      const created = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'R', directory: dir }),
      })
      const session = (await created.json()) as Session
      await ctx.db.db.update(sessions).set({ worktreePath: dir }).where(eq(sessions.id, session.id))
      // 模拟项目已删除：FK set null + 软删除会话
      const project = await fromDirectory(ctx.db, dir)
      await ctx.db.db.delete(projects).where(eq(projects.id, project.id))
      await ctx.db.db
        .update(sessions)
        .set({ deletedAt: new Date() })
        .where(eq(sessions.id, session.id))

      const res = await app.request(`/${session.id}/restore`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; rebound?: boolean; orphaned?: boolean }
      expect(body.ok).toBe(true)
      expect(body.rebound).toBe(true)
      // 归属重建：会话 projectId 不再为空
      const after = await app.request(`/${session.id}`)
      const restored = (await after.json()) as Session
      expect(restored.projectId).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('DELETE /:id/forever 彻底删除回收站会话（不可恢复）', async () => {
    const { app, db } = await setup()
    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'HardDelete' }),
    })
    const session = (await created.json()) as Session
    await app.request(`/${session.id}`, { method: 'DELETE' })
    const res = await app.request(`/${session.id}/forever`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; deleted: number }
    expect(body.ok).toBe(true)
    expect(body.deleted).toBeGreaterThanOrEqual(1)
    // 物理删除：回收站也不再有
    const deleted = await app.request('/deleted')
    const list = (await deleted.json()) as Session[]
    expect(list.some((s) => s.id === session.id)).toBe(false)
    // 未删除会话不可彻底删除 → 404
    const created2 = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Alive' }),
    })
    const alive = (await created2.json()) as Session
    const res2 = await app.request(`/${alive.id}/forever`, { method: 'DELETE' })
    expect(res2.status).toBe(404)
    void db
  })

  it('DELETE /deleted 清空回收站', async () => {
    const { app } = await setup()
    for (const title of ['A', 'B']) {
      const created = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      const session = (await created.json()) as Session
      await app.request(`/${session.id}`, { method: 'DELETE' })
    }
    const res = await app.request('/deleted', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; deleted: number }
    expect(body.ok).toBe(true)
    expect(body.deleted).toBeGreaterThanOrEqual(2)
    const after = await app.request('/deleted')
    expect((await after.json()) as Session[]).toEqual([])
  })

  it('GET /:id/archives 列出归档（含 /clear 归档），?q= 搜索', async () => {
    const { app, db } = await setup()
    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Archived' }),
    })
    const session = (await created.json()) as Session
    await archiveOriginalEntries(
      db,
      session.id,
      [
        {
          id: '11111111-1111-4111-8111-111111111111',
          sessionId: session.id,
          role: 'user',
          content: [{ _tag: 'text', text: '机密内容 xyz' }],
          tokenCount: 1,
          createdAt: Date.now(),
        },
      ],
      'clear',
      'Cleared 1 entries',
      '22222222-2222-4222-8222-222222222222',
    )
    const res = await app.request(`/${session.id}/archives`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { archives: unknown[] }
    expect(body.archives).toHaveLength(1)
    // 搜索命中
    const hit = await app.request(`/${session.id}/archives?q=${encodeURIComponent('xyz')}`)
    expect(((await hit.json()) as { archives: unknown[] }).archives).toHaveLength(1)
    // 搜索未命中
    const miss = await app.request(`/${session.id}/archives?q=${encodeURIComponent('nope')}`)
    expect(((await miss.json()) as { archives: unknown[] }).archives).toHaveLength(0)
  })

  it('GET /:id/export 导出会话（元数据 + 消息 + 归档）', async () => {
    const { app } = await setup()
    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ExportMe' }),
    })
    const session = (await created.json()) as Session
    const res = await app.request(`/${session.id}/export`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: number
      session: Session
      messages: unknown[]
      archives: unknown[]
    }
    expect(body.version).toBe(1)
    expect(body.session.id).toBe(session.id)
    expect(Array.isArray(body.messages)).toBe(true)
    expect(Array.isArray(body.archives)).toBe(true)
  })

  describe('POST /import 会话导入', () => {
    it('导入导出 JSON：新会话含原消息（id/时间戳保留）', async () => {
      const { app, ctx } = await setup()
      // 构造可导入载荷：一个项目 + 一条导出会话
      const projectId = 'import-target-project'
      await ctx.db.db.insert(projects).values({ id: projectId, worktree: '/tmp/import-target' })
      const created = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Origin', projectId }),
      })
      const origin = (await created.json()) as Session
      await ctx.db.db.insert(sessionEntries).values({
        sessionId: origin.id,
        tag: 'message',
        role: 'user',
        content: [{ _tag: 'text', text: 'hello import' }],
      })
      const exportRes = await app.request(`/${origin.id}/export`)
      const exported = (await exportRes.json()) as Record<string, unknown>

      const res = await app.request('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...exported, projectId }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        sessionId: string
        messageCount: number
      }
      expect(body.ok).toBe(true)
      expect(body.messageCount).toBe(1)

      // 导入后新会话属于目标项目，消息可读
      const msgs = await app.request(`/${body.sessionId}/messages`)
      const msgList = (await msgs.json()) as Array<{ role: string }>
      expect(msgList).toHaveLength(1)
      expect(msgList[0]?.role).toBe('user')
      const imported = await getSession(ctx.db, body.sessionId)
      expect(imported?.projectId).toBe(projectId)
      expect(imported?.title).toBe('Origin')
    })

    it('无效载荷（缺 version/session/messages）→ 400', async () => {
      const { app } = await setup()
      const res = await app.request('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('INVALID_EXPORT')
    })

    it('绑定不存在的项目 → 404', async () => {
      const { app } = await setup()
      const res = await app.request('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          session: { title: 'X' },
          messages: [],
          projectId: 'no-such-project',
        }),
      })
      expect(res.status).toBe(404)
    })

    it('同一导出重复导入 → 每次生成新会话（同库复制/恢复安全）', async () => {
      const { app, ctx } = await setup()
      const projectId = 'import-dup-project'
      await ctx.db.db.insert(projects).values({ id: projectId, worktree: '/tmp/import-dup' })
      const payload = {
        version: 1,
        session: { title: 'Dup' },
        projectId,
        messages: [
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            sessionId: 'ignored',
            role: 'user',
            content: [{ _tag: 'text', text: 'x' }],
            tokenCount: 1,
            createdAt: Date.now(),
          },
        ],
      }
      const first = await app.request('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      expect(first.status).toBe(200)
      const firstBody = (await first.json()) as { sessionId: string }
      const second = await app.request('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      expect(second.status).toBe(200)
      const secondBody = (await second.json()) as { sessionId: string }
      expect(secondBody.sessionId).not.toBe(firstBody.sessionId)
      // 两份均有完整消息
      const a = (await (await app.request(`/${firstBody.sessionId}/messages`)).json()) as unknown[]
      const b = (await (await app.request(`/${secondBody.sessionId}/messages`)).json()) as unknown[]
      expect(a).toHaveLength(1)
      expect(b).toHaveLength(1)
    })

    it('导入带 parentId 的导出 → flattened=true（分支树被扁平化）', async () => {
      const { app, ctx } = await setup()
      const projectId = 'import-flat-project'
      await ctx.db.db.insert(projects).values({ id: projectId, worktree: '/tmp/import-flat' })
      const res = await app.request('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          session: { title: 'Forked', parentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
          messages: [],
          projectId,
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { flattened: boolean }
      expect(body.flattened).toBe(true)
    })

    it('导入携带权限态 metadata → permissionMode/alwaysAllow 随迁', async () => {
      const { app, ctx } = await setup()
      const projectId = 'import-meta-project'
      await ctx.db.db.insert(projects).values({ id: projectId, worktree: '/tmp/import-meta' })
      const res = await app.request('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          session: {
            title: 'Auto',
            metadata: { permissionMode: 'auto', alwaysAllow: ['bash', 42], junk: 'x' },
          },
          messages: [],
          projectId,
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { sessionId: string; flattened: boolean }
      expect(body.flattened).toBe(false)
      const imported = await getSession(ctx.db, body.sessionId)
      expect(imported?.metadata.permissionMode).toBe('auto')
      // 白名单仅保留字符串工具名
      const meta = imported?.metadata as Record<string, unknown>
      expect(meta.alwaysAllow).toEqual(['bash'])
    })
  })

  describe('搜索回收站（P3）', () => {
    it('GET /search includeDeleted=1 命中回收站会话，默认搜索不含', async () => {
      const { app, ctx } = await setup()
      const created = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'trash-me' }),
      })
      const session = (await created.json()) as Session
      await ctx.db.db.insert(sessionEntries).values({
        sessionId: session.id,
        tag: 'message',
        role: 'user',
        content: [{ _tag: 'text', text: 'needle-content' }],
      })
      await app.request(`/${session.id}`, { method: 'DELETE' })

      // 默认搜索不含回收站
      const normalRes = await app.request('/search?q=trash-me')
      expect(((await normalRes.json()) as { results: unknown[] }).results).toHaveLength(0)

      // includeDeleted=1：标题与内容均可命中
      const titleRes = await app.request('/search?q=trash-me&includeDeleted=1')
      const titleBody = (await titleRes.json()) as {
        results: Array<{ session: { id: string }; matchedBy: string }>
      }
      expect(titleBody.results).toHaveLength(1)
      expect(titleBody.results[0]?.session.id).toBe(session.id)

      const contentRes = await app.request('/search?q=needle-content&includeDeleted=1')
      const contentBody = (await contentRes.json()) as {
        results: Array<{ session: { id: string }; matchedBy: string }>
      }
      expect(contentBody.results).toHaveLength(1)
      expect(contentBody.results[0]?.matchedBy).toBe('content')
    })
  })

  describe('删除运行中会话（P2）', () => {
    it('DELETE /:id 先中止该会话的活跃 run 再软删除', async () => {
      const { app, ctx } = await setup()
      const created = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'running' }),
      })
      const session = (await created.json()) as Session
      // 占位一个活跃 run（真实中止由 agentManager 内部处理，此处断言调用）
      ctx.agentManager.tryAcquire(session.id)
      const abortSpy = vi.spyOn(ctx.agentManager, 'abort')

      const res = await app.request(`/${session.id}`, { method: 'DELETE' })
      expect(res.status).toBe(204)
      expect(abortSpy).toHaveBeenCalledWith(session.id)
    })
  })

  describe('子树恢复（P2）', () => {
    it('POST /:id/restore 连带还原派生会话（删除级联的对称）', async () => {
      const { app, ctx } = await setup()
      const parent = await createSession(ctx.db, 'root')
      const child = await createSession(
        ctx.db,
        'branch',
        undefined,
        undefined,
        undefined,
        parent.id,
      )
      await app.request(`/${parent.id}`, { method: 'DELETE' })
      // 级联入回收站
      const deletedBefore = await listDeletedSessions(ctx.db)
      expect(deletedBefore).toHaveLength(2)

      const res = await app.request(`/${parent.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      // 父与分支一并还原
      expect(await listDeletedSessions(ctx.db)).toHaveLength(0)
      const restoredChild = await getSession(ctx.db, child.id)
      expect(restoredChild?.deletedAt).toBeNull()
    })
  })
})
