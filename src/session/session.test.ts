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
import { insertEntry } from './message.js'
import {
  createSession,
  getSession,
  listDeletedSessions,
  listSessions,
  purgeDeletedSessions,
  purgeEmptySessions,
  purgeTemporarySessions,
  restoreSession,
  restoreSessionCore,
  softDeleteSession,
  touchSession,
  touchTrashSeen,
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

  it('restore 连带还原整棵后代子树（P2：删除级联的对称）', async () => {
    const root = await createSession(handle, 'Root')
    const branch = await createSession(handle, 'Branch', undefined, undefined, undefined, root.id)
    const leaf = await createSession(handle, 'Leaf', undefined, undefined, undefined, branch.id)
    // 删除根会话 → 级联删除 branch 与 leaf
    await softDeleteSession(handle, root.id)
    expect(await listDeletedSessions(handle)).toHaveLength(3)

    const ok = await restoreSession(handle, root.id)
    expect(ok).toBe(true)
    expect(await listDeletedSessions(handle)).toHaveLength(0)
    expect((await getSession(handle, branch.id))?.deletedAt).toBeNull()
    expect((await getSession(handle, leaf.id))?.deletedAt).toBeNull()
  })

  it('恢复根会话不复活早先被单独删除的分支（删除/恢复批次对称，F2）', async () => {
    const root = await createSession(handle, 'Root')
    const branchA = await createSession(handle, 'A', undefined, undefined, undefined, root.id)
    const branchB = await createSession(handle, 'B', undefined, undefined, undefined, root.id)
    // 先单独删除 B
    await softDeleteSession(handle, branchB.id)
    // 再删除根：级联 root + A（B 先入回收站，保留更早的删除批次）
    await softDeleteSession(handle, root.id)
    expect(await listDeletedSessions(handle)).toHaveLength(3)

    // 恢复 root → 只还原 root + A；早先单独删除的 B 仍留在回收站
    const ok = await restoreSession(handle, root.id)
    expect(ok).toBe(true)
    expect((await getSession(handle, root.id))?.deletedAt).toBeNull()
    expect((await getSession(handle, branchA.id))?.deletedAt).toBeNull()
    expect((await getSession(handle, branchB.id))?.deletedAt).not.toBeNull()
  })

  it('restore 子会话不还原兄弟分支（只还原目标子树 + 祖先）', async () => {
    const root = await createSession(handle, 'Root')
    const branchA = await createSession(handle, 'A', undefined, undefined, undefined, root.id)
    const branchB = await createSession(handle, 'B', undefined, undefined, undefined, root.id)
    await softDeleteSession(handle, root.id)
    expect(await listDeletedSessions(handle)).toHaveLength(3)

    // 恢复 A → A + root 还原；兄弟 B 留在回收站
    const ok = await restoreSession(handle, branchA.id)
    expect(ok).toBe(true)
    expect((await getSession(handle, root.id))?.deletedAt).toBeNull()
    expect((await getSession(handle, branchA.id))?.deletedAt).toBeNull()
    expect((await getSession(handle, branchB.id))?.deletedAt).not.toBeNull()
  })

  it('restore includeDescendants:false 仅还原自身 + 祖先（旧语义可选）', async () => {
    const root = await createSession(handle, 'Root')
    const branch = await createSession(handle, 'Branch', undefined, undefined, undefined, root.id)
    await softDeleteSession(handle, root.id)

    const ok = await restoreSession(handle, root.id, { includeDescendants: false })
    expect(ok).toBe(true)
    expect((await getSession(handle, root.id))?.deletedAt).toBeNull()
    expect((await getSession(handle, branch.id))?.deletedAt).not.toBeNull()
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

  it('restoreSessionCore 报告跨批次祖先还原（用户早先单独删除的父会话被连带还原）', async () => {
    const root = await createSession(handle, 'Root')
    const a = await createSession(handle, 'A', undefined, undefined, undefined, root.id)
    const b = await createSession(handle, 'B', undefined, undefined, undefined, root.id)
    // 先单独删除 A（批次1）
    await softDeleteSession(handle, a.id)
    // 再删除 root（批次2：级联 root + B；A 已删不重复收集）
    await softDeleteSession(handle, root.id)
    expect(await listDeletedSessions(handle)).toHaveLength(3)

    // 恢复 A → 为可达性连带还原祖先 root（跨批次），兄弟 B 仍留回收站
    const r = await restoreSessionCore(handle, a.id)
    expect(r.restored).toBe(true)
    expect(r.restoredAncestorCount).toBe(1)
    expect(r.crossedBatchAncestor).toBe(true)
    expect((await getSession(handle, root.id))?.deletedAt).toBeNull()
    expect((await getSession(handle, b.id))?.deletedAt).not.toBeNull()
  })

  it('restoreSessionCore 同批次祖先还原不标记跨批次', async () => {
    const root = await createSession(handle, 'Root')
    const a = await createSession(handle, 'A', undefined, undefined, undefined, root.id)
    await softDeleteSession(handle, root.id)
    const r = await restoreSessionCore(handle, a.id)
    expect(r.restored).toBe(true)
    expect(r.restoredAncestorCount).toBe(1)
    expect(r.crossedBatchAncestor).toBe(false)
  })
})

describe('purgeDeletedSessions — 两阶段清理（A3：到期先标记，宽限期后清除）', () => {
  let handle: DB
  beforeEach(async () => {
    handle = await setupDB()
  })

  it('从未被看到的已删会话（超期）不会被标记也不会被清除', async () => {
    const s = await createSession(handle, 'NeverSeen')
    await softDeleteSession(handle, s.id)
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    await handle.db.update(sessions).set({ deletedAt: old }).where(eq(sessions.id, s.id))
    const r = await purgeDeletedSessions(handle)
    expect(r).toEqual({ marked: 0, deleted: 0 })
    expect(await getSession(handle, s.id)).not.toBeNull()
  })

  it('被看到且超过保留期 → 首次仅标记进入宽限期，不物理清除', async () => {
    const s = await createSession(handle, 'Seen')
    await softDeleteSession(handle, s.id)
    const oldMs = Date.now() - 100 * 24 * 60 * 60 * 1000
    await handle.db
      .update(sessions)
      .set({ deletedAt: new Date(oldMs - 1000), metadata: { trashSeenAt: oldMs } })
      .where(eq(sessions.id, s.id))
    const r = await purgeDeletedSessions(handle)
    expect(r).toEqual({ marked: 1, deleted: 0 })
    expect(await getSession(handle, s.id)).not.toBeNull()
    expect((await getSession(handle, s.id))?.metadata.purgePendingAt).toBeDefined()
  })

  it('标记后宽限期未满 → 不物理清除；再次调用不重复标记', async () => {
    const s = await createSession(handle, 'Grace')
    await softDeleteSession(handle, s.id)
    const oldMs = Date.now() - 100 * 24 * 60 * 60 * 1000
    await handle.db
      .update(sessions)
      .set({ deletedAt: new Date(oldMs - 1000), metadata: { trashSeenAt: oldMs } })
      .where(eq(sessions.id, s.id))
    expect(await purgeDeletedSessions(handle)).toEqual({ marked: 1, deleted: 0 })
    // 宽限期内重复调用：不重复标记
    expect(await purgeDeletedSessions(handle)).toEqual({ marked: 0, deleted: 0 })
    expect(await getSession(handle, s.id)).not.toBeNull()
  })

  it('标记超过宽限期后物理清除', async () => {
    const s = await createSession(handle, 'PurgeNow')
    await softDeleteSession(handle, s.id)
    const oldMs = Date.now() - 100 * 24 * 60 * 60 * 1000
    const meta = { trashSeenAt: oldMs, purgePendingAt: Date.now() - 10 * 24 * 60 * 60 * 1000 }
    await handle.db
      .update(sessions)
      .set({ deletedAt: new Date(oldMs - 1000), metadata: meta })
      .where(eq(sessions.id, s.id))
    const r = await purgeDeletedSessions(handle)
    expect(r.deleted).toBe(1)
    expect(await getSession(handle, s.id)).toBeNull()
  })

  it('恢复后重删、未重新看到 → 软删除已清除旧标记，不被过早标记', async () => {
    const s = await createSession(handle, 'Redel')
    await softDeleteSession(handle, s.id)
    await touchTrashSeen(handle)
    // 上一周期的「看到」时间拨到 120 天前
    const prevSeen = Date.now() - 120 * 24 * 60 * 60 * 1000
    await handle.db
      .update(sessions)
      .set({ metadata: { trashSeenAt: prevSeen } })
      .where(eq(sessions.id, s.id))
    await restoreSession(handle, s.id)
    await softDeleteSession(handle, s.id)
    // A3：软删除清除 trashSeenAt → 重删会话未被重新看到，不进宽限期
    expect((await getSession(handle, s.id))?.metadata.trashSeenAt).toBeUndefined()
    // 重删时间拨到 100 天前（同样超期）
    const reDeleted = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    await handle.db.update(sessions).set({ deletedAt: reDeleted }).where(eq(sessions.id, s.id))
    expect(await purgeDeletedSessions(handle)).toEqual({ marked: 0, deleted: 0 })
    expect(await getSession(handle, s.id)).not.toBeNull()
  })

  it('touchTrashSeen 仅标记首次看到，不随重复打开重置', async () => {
    const s = await createSession(handle, 'SeenOnce')
    await softDeleteSession(handle, s.id)
    await touchTrashSeen(handle)
    const first = (await getSession(handle, s.id))?.metadata.trashSeenAt
    expect(first).toBeDefined()
    // 第二次打开回收站：标记不重置，倒计时稳定
    await touchTrashSeen(handle)
    expect((await getSession(handle, s.id))?.metadata.trashSeenAt).toBe(first)
  })

  it('touchTrashSeen 按 projectId 隔离标记', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'seen-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'seen-b-'))
    try {
      const pa = await fromDirectory(handle, dirA)
      const pb = await fromDirectory(handle, dirB)
      const sa = await createSession(handle, 'A', pa.id)
      const sb = await createSession(handle, 'B', pb.id)
      await softDeleteSession(handle, sa.id)
      await softDeleteSession(handle, sb.id)
      await touchTrashSeen(handle, { projectId: pa.id })
      expect((await getSession(handle, sa.id))?.metadata.trashSeenAt).toBeDefined()
      expect((await getSession(handle, sb.id))?.metadata.trashSeenAt).toBeUndefined()
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  it('A2：restoreSessionCore 返回未随恢复的已删后代数量', async () => {
    const root = await createSession(handle, 'Root')
    const branchA = await createSession(handle, 'BranchA', undefined, undefined, 'web', root.id)
    const branchB = await createSession(handle, 'BranchB', undefined, undefined, 'web', root.id)
    // 批次一：branchB 早先单独删除
    await softDeleteSession(handle, branchB.id)
    // 批次二：root + branchA（branchB 已删，不参与级联）一起删除
    await softDeleteSession(handle, root.id)
    const r = await restoreSessionCore(handle, root.id)
    expect(r.restored).toBe(true)
    expect(r.leftBehindDescendantCount).toBe(1)
    expect((await getSession(handle, branchA.id))?.deletedAt).toBeNull()
    expect((await getSession(handle, branchB.id))?.deletedAt).not.toBeNull()
  })
})

describe('purgeEmptySessions — 空会话 GC（C4）', () => {
  let handle: DB
  beforeEach(async () => {
    handle = await setupDB()
  })

  it('清理超过保留期的空 web 会话，保留有消息/子会话/CLI/新会话', async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const empty = await createSession(handle, 'Empty')
    const withMsg = await createSession(handle, 'HasMsg')
    const parent = await createSession(handle, 'Parent')
    await createSession(handle, 'Child', undefined, undefined, 'web', parent.id)
    const cli = await createSession(handle, 'Cli', undefined, undefined, 'cli')
    const fresh = await createSession(handle, 'Fresh')
    // 有消息的会话写入一条条目
    await insertEntry(handle, {
      sessionId: withMsg.id,
      tag: 'message',
      role: 'user',
      content: [{ _tag: 'text', text: 'hi' }],
    })
    for (const id of [empty.id, withMsg.id, parent.id, cli.id]) {
      await handle.db.update(sessions).set({ createdAt: old }).where(eq(sessions.id, id))
    }
    const purged = await purgeEmptySessions(handle)
    expect(purged).toBe(1)
    expect(await getSession(handle, empty.id)).toBeNull()
    expect(await getSession(handle, withMsg.id)).not.toBeNull()
    expect(await getSession(handle, parent.id)).not.toBeNull()
    expect(await getSession(handle, cli.id)).not.toBeNull()
    expect(await getSession(handle, fresh.id)).not.toBeNull()
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
