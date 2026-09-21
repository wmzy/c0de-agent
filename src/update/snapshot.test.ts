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
      agentType: null,
      worktreePath: null,
      source: null,
      deletedAt: null,
      deletedBatchId: null,
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
      agentType: null,
      worktreePath: null,
      source: null,
      deletedAt: null,
      deletedBatchId: null,
      createdAt: 1,
      updatedAt: 1,
    }
    const ordered = orderSessionsByParent([child, parent])
    expect(ordered.map((s) => s.id)).toEqual(['p', 'c'])
  })

  // 回归：seen 在「访问父级之后」才收录当前节点——parentId 成环（a↔b 互指或
  // 自引用）时 visit 在环上无限递归直至栈溢出（RangeError 击穿热更新快照）。
  // 删除路径（purgeDeletedSessions）对同型环数据已有兜底，序列化路径必须同样
  // 终止：环上节点各出现一次，正常节点拓扑序不受影响。
  it('terminates on parentId cycles instead of overflowing the stack', () => {
    const base = {
      title: 'x',
      projectId: null,
      branchPoint: null,
      metadata: {},
      agentType: null,
      worktreePath: null,
      source: null,
      deletedAt: null,
      deletedBatchId: null,
      createdAt: 1,
      updatedAt: 1,
    }
    const mk = (id: string, parentId: string | null) => ({ id, parentId, ...base })

    // a↔b 互指环
    const ordered = orderSessionsByParent([mk('a', 'b'), mk('b', 'a')])
    expect(ordered.map((s) => s.id).sort()).toEqual(['a', 'b'])

    // 自引用
    const selfOrdered = orderSessionsByParent([mk('s', 's')])
    expect(selfOrdered.map((s) => s.id)).toEqual(['s'])

    // 正常父子序不受影响
    const mixed = orderSessionsByParent([mk('c', 'p'), mk('p', null), mk('a', 'b'), mk('b', 'a')])
    expect(mixed.slice(0, 2).map((s) => s.id)).toEqual(['p', 'c'])
    expect(mixed.map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'p'])
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
