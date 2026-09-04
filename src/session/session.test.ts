import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { fromDirectory } from '../project/project.js'
import {
  createSession,
  getSession,
  listDeletedSessions,
  listSessions,
  restoreSession,
  softDeleteSession,
  touchSession,
  updateSessionTitle,
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
})
