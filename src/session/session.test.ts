import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { sessions } from '../db/schema.js'
import { fromDirectory } from '../project/project.js'
import { markDeadBackgroundJobs } from './jobs.js'
import {
  createSession,
  getSession,
  listDeletedSessions,
  listSessions,
  purgeTemporarySessions,
  restoreSession,
  softDeleteSession,
  touchSession,
  updateSessionLastRun,
  updateSessionTitle,
  upgradeTemporarySession,
} from './session.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

describe('session CRUD', () => {
  let handle: DB

  beforeEach(async () => {
    handle = await setupDB()
  })

  it('creates a session with generated id and timestamps', async () => {
    const session = await createSession(handle, 'My Chat')
    expect(session.id).toBeTruthy()
    expect(session.title).toBe('My Chat')
    expect(session.parentId).toBeNull()
    expect(session.branchPoint).toBeNull()
    expect(session.metadata).toEqual({})
    expect(session.createdAt).toBeGreaterThan(0)
    expect(session.updatedAt).toBeGreaterThan(0)
  })

  it('retrieves a session by id', async () => {
    const created = await createSession(handle, 'Test')
    const found = await getSession(handle, created.id)
    expect(found).not.toBeNull()
    expect(found?.title).toBe('Test')
  })

  it('returns null for non-existent session', async () => {
    const found = await getSession(handle, '00000000-0000-0000-0000-000000000000')
    expect(found).toBeNull()
  })

  it('lists all sessions', async () => {
    await createSession(handle, 'A')
    await createSession(handle, 'B')
    const list = await listSessions(handle)
    expect(list).toHaveLength(2)
  })

  it('updates a session title', async () => {
    const created = await createSession(handle, 'Old')
    await updateSessionTitle(handle, created.id, 'New')
    const found = await getSession(handle, created.id)
    expect(found?.title).toBe('New')
  })

  it('soft-deletes a session', async () => {
    const created = await createSession(handle, 'Gone')
    const ok = await softDeleteSession(handle, created.id)
    expect(ok).toBe(true)
    // 软删除后从活跃列表消失，但记录仍在（回收站可见）
    expect(await listSessions(handle)).toHaveLength(0)
    expect(await listDeletedSessions(handle)).toHaveLength(1)
    expect(await getSession(handle, created.id)).not.toBeNull()
  })

  it('restores a soft-deleted session', async () => {
    const created = await createSession(handle, 'Revive')
    await softDeleteSession(handle, created.id)
    const ok = await restoreSession(handle, created.id)
    expect(ok).toBe(true)
    expect(await listSessions(handle)).toHaveLength(1)
    expect(await listDeletedSessions(handle)).toHaveLength(0)
  })

  it('restore 连带恢复已删除祖先（P2-1：恢复的子会话不再游离于树外）', async () => {
    const parent = await createSession(handle, 'Parent')
    const child = await createSession(handle, 'Child')
    await handle.db.update(sessions).set({ parentId: parent.id }).where(eq(sessions.id, child.id))
    // 删除父会话 → 级联删除子会话
    await softDeleteSession(handle, parent.id)
    expect(await listDeletedSessions(handle)).toHaveLength(2)

    // 恢复子会话 → 祖先链一并还原
    const ok = await restoreSession(handle, child.id)
    expect(ok).toBe(true)
    expect(await listDeletedSessions(handle)).toHaveLength(0)
    const restoredParent = await getSession(handle, parent.id)
    expect(restoredParent?.deletedAt).toBeNull()
  })

  it('touches updatedAt without changing title', async () => {
    const created = await createSession(handle, 'Persist')
    const originalUpdatedAt = created.updatedAt
    await new Promise((r) => setTimeout(r, 10))
    await touchSession(handle, created.id)
    const found = await getSession(handle, created.id)
    expect(found?.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt)
  })

  it('createSession without projectId yields null projectId', async () => {
    const s = await createSession(handle, 'T')
    expect(s.projectId).toBeNull()
  })

  it('createSession with projectId associates project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sess-'))
    try {
      const project = await fromDirectory(handle, dir)
      const s = await createSession(handle, 'T', project.id)
      expect(s.projectId).toBe(project.id)
      const refetched = await getSession(handle, s.id)
      expect(refetched?.projectId).toBe(project.id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('createSession with parentId sets parentId (子 agent 会话挂树)', async () => {
    const parent = await createSession(handle, 'P')
    const child = await createSession(handle, 'C', undefined, 'coder', undefined, parent.id)
    expect(child.parentId).toBe(parent.id)
  })
})

describe('purgeTemporarySessions', () => {
  let handle: DB
  beforeEach(async () => {
    handle = await setupDB()
  })

  it('仅清理标记 print/workflow 的临时会话，保留普通 CLI 与 web 会话', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const print = await createSession(handle, 'cli-print', undefined, 'print', 'cli')
    const wf = await createSession(handle, 'workflow:x', undefined, 'workflow')
    const web = await createSession(handle, 'web')
    // 普通 CLI 会话（ACP 等，无 print 标记）：过期也不清理
    const plainCli = await createSession(handle, 'cli-persist', undefined, undefined, 'cli')
    const recentPrint = await createSession(handle, 'cli-recent', undefined, 'print', 'cli')
    await handle.db.update(sessions).set({ updatedAt: old }).where(eq(sessions.id, print.id))
    await handle.db.update(sessions).set({ updatedAt: old }).where(eq(sessions.id, wf.id))
    await handle.db.update(sessions).set({ updatedAt: old }).where(eq(sessions.id, plainCli.id))
    const purged = await purgeTemporarySessions(handle)
    expect(purged).toBe(2)
    expect(await getSession(handle, print.id)).toBeNull()
    expect(await getSession(handle, wf.id)).toBeNull()
    expect(await getSession(handle, web.id)).not.toBeNull()
    expect(await getSession(handle, plainCli.id)).not.toBeNull()
    expect(await getSession(handle, recentPrint.id)).not.toBeNull()
  })

  it('upgradeTemporarySession 清除 print 标记后不再被清理', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const print = await createSession(handle, 'cli-print', undefined, 'print', 'cli')
    await upgradeTemporarySession(handle, print.id)
    await handle.db.update(sessions).set({ updatedAt: old }).where(eq(sessions.id, print.id))
    const purged = await purgeTemporarySessions(handle)
    expect(purged).toBe(0)
    expect(await getSession(handle, print.id)).not.toBeNull()
  })
})

describe('markDeadBackgroundJobs', () => {
  let handle: DB
  beforeEach(async () => {
    handle = await setupDB()
  })

  it('标记悬空后台任务并给父会话发失败通知', async () => {
    const parent = await createSession(handle, 'parent')
    const child = await createSession(handle, 'child', undefined, 'coder', undefined, parent.id)
    await updateSessionLastRun(handle, child.id, {
      status: 'running',
      agentName: 'coder',
      startedAt: Date.now(),
    })
    const marked = await markDeadBackgroundJobs(handle)
    expect(marked).toBe(1)
    const { getMessages } = await import('./message.js')
    const messages = await getMessages(handle, parent.id)
    const failedNotice = messages.filter(
      (m) =>
        m.role === 'user' &&
        m.content.some((p) => p._tag === 'text' && p.text.includes('state="failed"')),
    )
    expect(failedNotice).toHaveLength(1)
  })

  it('正常完成的后台任务不被标记', async () => {
    const parent = await createSession(handle, 'parent2')
    const child = await createSession(handle, 'child2', undefined, 'coder', undefined, parent.id)
    await updateSessionLastRun(handle, child.id, {
      status: 'completed',
      agentName: 'coder',
      startedAt: Date.now(),
    })
    expect(await markDeadBackgroundJobs(handle)).toBe(0)
  })
})
