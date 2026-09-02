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

  it('未传 mtimeMs 时从已有快照行透传（压缩/squash 调用点避免冗余重读）', async () => {
    // 首次快照带 mtimeMs（如 @文件写入路径）
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'v1', 123_456)
    // 模拟 compaction/squash 从工具结果重建快照：不传 mtimeMs
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'v2')
    const latest = await getLatestFileSnapshot(handle, sessionId, '/a.ts')
    expect(latest?.content).toBe('v2')
    expect(latest?.version).toBe(2)
    // 继承旧值而非置空 → 下次注入前比对不误判过期、不多一轮重读
    expect(latest?.mtimeMs).toBe(123_456)

    // 无已有行的首次写入（无 mtime 可透传）仍保持 undefined
    await upsertFileSnapshot(handle, sessionId, '/b.ts', 'b1')
    const first = await getLatestFileSnapshot(handle, sessionId, '/b.ts')
    expect(first?.mtimeMs).toBeUndefined()
  })

  it('显式传入的 mtimeMs 优先于已有行透传值', async () => {
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'v1', 111)
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'v2', 222)
    const latest = await getLatestFileSnapshot(handle, sessionId, '/a.ts')
    expect(latest?.mtimeMs).toBe(222)
  })
})
