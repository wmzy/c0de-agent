import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import {
  appendMessage,
  createSession,
  forkSession,
  getMessages,
  listSessions,
} from '../session/index.js'
import type { MessageContent } from '../shared/types/message.js'
import {
  orderSessionsByParent,
  restoreSessions,
  type SessionSnapshot,
  serializeSessions,
} from './snapshot.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('orderSessionsByParent', () => {
  it('places parent before child regardless of input order', () => {
    const child = {
      id: 'c',
      title: 'c',
      parentId: 'p',
      projectId: null,
      branchPoint: 2,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const parent = {
      id: 'p',
      title: 'p',
      parentId: null,
      projectId: null,
      branchPoint: null,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const ordered = orderSessionsByParent([child, parent])
    expect(ordered.map((s) => s.id)).toEqual(['p', 'c'])
  })
})

describe('serialize / restore round-trip', () => {
  let source: DB
  let target: DB

  beforeEach(async () => {
    source = await setupDB()
    target = await setupDB()
  })

  afterEach(async () => {
    // PGLite WASM 实例必须显式 release，否则多个测试会 OOM（见 db/client 注释）
    await source?.close()
    await target?.close()
  })

  it('round-trips sessions and messages across DBs', async () => {
    const s1 = await createSession(source, 'Session One')
    await appendMessage(source, s1.id, { role: 'user', content: textContent('hello') })
    await appendMessage(source, s1.id, { role: 'assistant', content: textContent('hi') })

    const snapshot: SessionSnapshot = await serializeSessions(source, { theme: 'dark' })
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.config).toEqual({ theme: 'dark' })

    await restoreSessions(target, snapshot)

    const restored = await listSessions(target)
    expect(restored).toHaveLength(1)
    expect(restored[0]?.title).toBe('Session One')
    const r0 = restored[0]
    if (!r0) throw new Error('restore failed: no session')
    const msgs = await getMessages(target, r0.id)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]?.role).toBe('user')
  })

  it('restores fork tree with parent-before-child ordering', async () => {
    const root = await createSession(source, 'root')
    await appendMessage(source, root.id, { role: 'user', content: textContent('m') })
    await forkSession(source, root.id, 0)

    const snapshot = await serializeSessions(source)
    // 故意打乱顺序，验证拓扑排序恢复
    snapshot.sessions.reverse()

    await restoreSessions(target, snapshot)
    const restored = await listSessions(target)
    expect(restored.map((s) => s.title).sort()).toEqual(['Branch of root', 'root'])
    expect(restored.some((s) => s.parentId !== null)).toBe(true)
  })

  it('restore is idempotent (onConflictDoNothing)', async () => {
    const s = await createSession(source, 'dup')
    await appendMessage(source, s.id, { role: 'user', content: textContent('x') })
    const snapshot = await serializeSessions(source)
    await restoreSessions(target, snapshot)
    await restoreSessions(target, snapshot) // 第二次不应重复
    expect(await listSessions(target)).toHaveLength(1)
  })
})
