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
import { restoreSessions, type SessionSnapshot, serializeSessions } from './snapshot.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

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

  // 回归：orderSessionsByParent 对 parentId 成环数据只保证「终止」，产出的顺序
  // 却是子先于父——restoreSessions 按该顺序逐个插入时，自引用 FK（parent_id →
  // sessions.id）对先插入的环上节点抛 23503，整个恢复击穿：热更新快照含环数据
  // （a↔b 互指/自引用，删除路径已处理的同型数据）时 serve 启动即失败。恢复必须
  // 两阶段（先全部插入、再回填 parentId），环上节点的父指针完整保留。
  it('restores cyclic parentId snapshots (a↔b / self-loop) without FK violation', async () => {
    const now = Date.now()
    const mk = (id: string, parentId: string | null) => ({
      id,
      title: `s-${id}`,
      parentId,
      projectId: null,
      branchPoint: null,
      metadata: {},
      agentType: null,
      worktreePath: null,
      source: 'web',
      deletedAt: null,
      deletedBatchId: null,
      createdAt: now,
      updatedAt: now,
    })
    const a = 'aaaaaaaa-1111-4111-8111-111111111111'
    const b = 'bbbbbbbb-2222-4222-8222-222222222222'
    const self = 'cccccccc-3333-4333-8333-333333333333'
    const snapshot: SessionSnapshot = {
      version: '0.1.0',
      sessions: [mk(a, b), mk(b, a), mk(self, self)],
      entries: [],
      config: null,
      timestamp: now,
    }

    await restoreSessions(target, snapshot)

    const restored = await listSessions(target)
    expect(restored).toHaveLength(3)
    expect(restored.find((s) => s.id === a)?.parentId).toBe(b)
    expect(restored.find((s) => s.id === b)?.parentId).toBe(a)
    expect(restored.find((s) => s.id === self)?.parentId).toBe(self)
  })

  it('P1：终端元信息随快照序列化（新实例据此原位重建 shell）', async () => {
    const terminals = [
      { id: 'pty_a', shell: '/bin/zsh', cwd: '/repo', title: 'dev server' },
      { id: 'pty_b', shell: '/bin/bash', cwd: '/repo/pkg', title: 'bash', projectId: 'p1' },
    ]
    const snapshot = await serializeSessions(source, undefined, terminals)
    expect(snapshot.terminals).toEqual(terminals)
    // restoreSessions 只回放 DB；终端重建由 server bootstrap 消费 snapshot.terminals
    await restoreSessions(target, snapshot)
  })

  it('无终端时不携带 terminals 字段（旧快照兼容）', async () => {
    const snapshot = await serializeSessions(source)
    expect(snapshot.terminals).toBeUndefined()
  })
})
