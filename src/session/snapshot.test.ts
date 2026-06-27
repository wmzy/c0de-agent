import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { createSession } from './session.js'
import {
  checkFileSnapshot,
  getFileSnapshots,
  getLatestFileSnapshot,
  upsertFileSnapshot,
} from './snapshot.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

describe('file snapshots', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('creates a snapshot and returns its id', async () => {
    const id = await upsertFileSnapshot(handle, sessionId, '/src/a.ts', 'const x = 1')
    expect(id).toBeTruthy()
  })

  it('retrieves the latest snapshot for a file', async () => {
    await upsertFileSnapshot(handle, sessionId, '/src/a.ts', 'v1')
    await upsertFileSnapshot(handle, sessionId, '/src/a.ts', 'v2')
    const latest = await getLatestFileSnapshot(handle, sessionId, '/src/a.ts')
    expect(latest?.content).toBe('v2')
    expect(latest?.version).toBe(2)
  })

  it('lists all snapshots for a session', async () => {
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'a')
    await upsertFileSnapshot(handle, sessionId, '/b.ts', 'b')
    const snapshots = await getFileSnapshots(handle, sessionId)
    expect(snapshots).toHaveLength(2)
  })

  it('checkFileSnapshot returns content when snapshot exists', async () => {
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'cached content')
    const content = await checkFileSnapshot(handle, sessionId, '/a.ts')
    expect(content).toBe('cached content')
  })

  it('checkFileSnapshot returns null when no snapshot', async () => {
    const content = await checkFileSnapshot(handle, sessionId, '/missing.ts')
    expect(content).toBeNull()
  })

  it('computes content hash and token count', async () => {
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'hello world')
    const latest = await getLatestFileSnapshot(handle, sessionId, '/a.ts')
    expect(latest?.contentHash).toHaveLength(64) // sha256 hex
    expect(latest?.tokenCount).toBeGreaterThan(0)
  })
})
