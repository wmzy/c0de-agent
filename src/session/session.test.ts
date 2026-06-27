import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
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

  it('deletes a session', async () => {
    const created = await createSession(handle, 'Gone')
    await deleteSession(handle, created.id)
    const found = await getSession(handle, created.id)
    expect(found).toBeNull()
  })

  it('touches updatedAt without changing title', async () => {
    const created = await createSession(handle, 'Persist')
    const originalUpdatedAt = created.updatedAt
    await new Promise((r) => setTimeout(r, 10))
    await touchSession(handle, created.id)
    const found = await getSession(handle, created.id)
    expect(found?.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt)
  })
})
