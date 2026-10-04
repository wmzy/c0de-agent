import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { sessions } from '../db/schema.js'
import { createTestDB, resetTestDB } from '../db/test-utils.js'
import { fromDirectory } from '../project/project.js'
import { markDeadBackgroundJobs } from './jobs.js'
import { insertEntry } from './message.js'
import {
  createSession,
  emptyTrash,
  getSession,
  listDeletedSessions,
  listSessions,
  permanentlyDeleteSession,
  purgeDeletedSessions,
  purgeEmptySessions,
  purgeTemporarySessions,
  rebindSession,
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
  return dbHandle
}

let dbHandle: DB

beforeAll(async () => {
  dbHandle = await createTestDB()
})
afterAll(async () => {
  await dbHandle.close()
})
afterEach(async () => {
  await resetTestDB(dbHandle)
})

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

  it('listSessions：一次性 print/workflow CLI 会话隐藏，持久 CLI（已续接/ACP）可见', async () => {
    const print = await createSession(handle, 'cli-print', undefined, 'print', 'cli')
    const wf = await createSession(handle, 'workflow:x', undefined, 'workflow')
    const persistedCli = await createSession(handle, 'cli-persist', undefined, undefined, 'cli')
    const web = await createSession(handle, 'web')
    const ids = (await listSessions(handle)).map((s) => s.id)
    expect(ids).toContain(persistedCli.id)
    expect(ids).toContain(web.id)
    expect(ids).not.toContain(print.id)
    // workflow 会话 source 为 null（历史数据视为 web）：行为与改动前一致，不额外过滤。
    expect(ids).toContain(wf.id)
  })

  it('createSession 携带 worktreePath 落盘（CLI 会话 Web 打开的 cwd 兜底）', async () => {
    const s = await createSession(
      handle,
      'cli-cwd',
      undefined,
      undefined,
      'cli',
      undefined,
      '/tmp/proj',
    )
    expect(s.worktreePath).toBe('/tmp/proj')
    const loaded = await getSession(handle, s.id)
    expect(loaded?.worktreePath).toBe('/tmp/proj')
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

  // 回归：祖先链遍历（while (parentId)）无环守卫——parentId 成环数据
  // （a↔b 互指/自引用，热更新快照恢复或手改 DB 均可产生）会让循环在环上
  // 无限打转，每圈一条 DB 查询，恢复请求永不返回（同型：orderSessionsByParent
  // 的栈溢出、purgeDeletedSessions 的循环引用兜底均已加守卫，此面漏了）。
  it('terminates on a parentId cycle instead of looping forever', async () => {
    const a = await createSession(handle, 'A')
    const b = await createSession(handle, 'B')
    // 构造 a↔b 互指环并同时软删（绕过 softDeleteSession 的 BFS 级联，直接落环）
    await handle.db.update(sessions).set({ parentId: b.id }).where(eq(sessions.id, a.id))
    await handle.db.update(sessions).set({ parentId: a.id }).where(eq(sessions.id, b.id))
    const now = new Date()
    for (const id of [a.id, b.id]) {
      await handle.db.update(sessions).set({ deletedAt: now }).where(eq(sessions.id, id))
    }

    const outcome = await Promise.race([
      restoreSessionCore(handle, a.id).then(
        (r) => ({ kind: 'restored' as const, r }),
        // 修复前若在环上打转直至 DB 关闭，拒绝也按「未正常返回」计入
        () => ({ kind: 'hung' as const }),
      ),
      new Promise<{ kind: 'hung' }>((resolve) => setTimeout(() => resolve({ kind: 'hung' }), 1200)),
    ])
    expect(outcome.kind).toBe('restored')
    if (outcome.kind === 'restored') {
      expect(outcome.r.restored).toBe(true)
    }
    // 环上两个会话都已还原（不再滞留在环上打转）
    expect((await getSession(handle, a.id))?.deletedAt).toBeNull()
    expect((await getSession(handle, b.id))?.deletedAt).toBeNull()
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

  it('绝对上限：从未被看到但删除超过 365 天的条目进入宽限期标记（不再永久滞留）', async () => {
    const s = await createSession(handle, 'AncientNeverSeen')
    await softDeleteSession(handle, s.id)
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    await handle.db.update(sessions).set({ deletedAt: old }).where(eq(sessions.id, s.id))
    const r = await purgeDeletedSessions(handle)
    expect(r).toEqual({ marked: 1, deleted: 0 })
    const meta = (await getSession(handle, s.id))?.metadata
    expect(meta?.purgePendingAt).toBeDefined()
  })

  it('绝对上限：宽限期满后物理清除（无论是否被看到过）', async () => {
    const s = await createSession(handle, 'AncientPurged')
    await softDeleteSession(handle, s.id)
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    await handle.db
      .update(sessions)
      .set({
        deletedAt: old,
        metadata: { purgePendingAt: Date.now() - 10 * 24 * 60 * 60 * 1000 },
      })
      .where(eq(sessions.id, s.id))
    const r = await purgeDeletedSessions(handle)
    expect(r).toEqual({ marked: 0, deleted: 1 })
    expect(await getSession(handle, s.id)).toBeNull()
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

  it('P1：物理清除的删除闭包含全部后代——跨项目/未到期的已删子行一并清除（不再撞自引用 FK）', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'purge-cross-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'purge-cross-b-'))
    try {
      const pa = await fromDirectory(handle, dirA)
      const pb = await fromDirectory(handle, dirB)
      const parent = await createSession(handle, 'Parent', pa.id)
      const child = await createSession(handle, 'Child', pa.id, undefined, 'web', parent.id)
      // 子会话改归属到另一项目（孤儿归属/恢复路径可达）——删除级联仍会把它一并
      // 移入回收站（级联按 parentId，与项目归属无关）。
      expect(await rebindSession(handle, child.id, pb)).toBe(true)
      await softDeleteSession(handle, parent.id)
      expect((await getSession(handle, child.id))?.deletedAt).not.toBeNull()
      // 仅 parent 进入宽限期：child 未到期、不在本次清除集合内，但引用 parent。
      // 只按「待清除集合」排序会先删 parent → FK 23503 → 整个清理失败（静默）。
      await handle.db
        .update(sessions)
        .set({
          deletedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
          metadata: { purgePendingAt: Date.now() - 10 * 24 * 60 * 60 * 1000 },
        })
        .where(eq(sessions.id, parent.id))
      const r = await purgeDeletedSessions(handle)
      expect(r.deleted).toBe(2)
      expect(await getSession(handle, parent.id)).toBeNull()
      expect(await getSession(handle, child.id)).toBeNull()
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  it('P1：环数据（parentId 互指）不阻断清理——断开父指针后整体清除', async () => {
    const a = await createSession(handle, 'CycleA')
    const b = await createSession(handle, 'CycleB')
    await handle.db.update(sessions).set({ parentId: b.id }).where(eq(sessions.id, a.id))
    await handle.db.update(sessions).set({ parentId: a.id }).where(eq(sessions.id, b.id))
    await softDeleteSession(handle, a.id)
    // 未到期：仅验证不抛错、不误删
    expect(await purgeDeletedSessions(handle)).toEqual({ marked: 0, deleted: 0 })
    await handle.db
      .update(sessions)
      .set({ metadata: { purgePendingAt: Date.now() - 10 * 24 * 60 * 60 * 1000 } })
      .where(eq(sessions.id, a.id))
    // 环内两节点互为父/子，无拓扑序可解：先断开父指针再删（此前无叶可删时逐个
    // delete 仍违反自引用 FK，清理整体抛错）。
    const r2 = await purgeDeletedSessions(handle)
    expect(r2.deleted).toBe(2)
    expect(await getSession(handle, a.id)).toBeNull()
    expect(await getSession(handle, b.id)).toBeNull()
  })
})

describe('emptyTrash — 清空回收站（按项目/全库）', () => {
  let handle: DB
  beforeEach(async () => {
    handle = await setupDB()
  })

  it('按项目清空：连带清除该项目之外的已删子行（跨项目引用不撞 FK）', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'trash-x-'))
    const dirB = mkdtempSync(join(tmpdir(), 'trash-y-'))
    try {
      const px = await fromDirectory(handle, dirA)
      const py = await fromDirectory(handle, dirB)
      const parent = await createSession(handle, 'Parent', px.id)
      const child = await createSession(handle, 'Child', px.id, undefined, 'web', parent.id)
      await rebindSession(handle, child.id, py)
      await softDeleteSession(handle, parent.id)
      // 子行在项目 Y 的回收站里：项目 X 的「清空回收站」此前只按 X 的条目排序，
      // 先删 parent 即撞 FK 23503（REST 500），X 的回收站永远清不掉。
      const deleted = await emptyTrash(handle, px.id)
      expect(deleted).toBe(2)
      expect(await getSession(handle, parent.id)).toBeNull()
      expect(await getSession(handle, child.id)).toBeNull()
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  it('全库清空：已删父的未删子行（数据异常）随子树一并清除，不撞 FK', async () => {
    const parent = await createSession(handle, 'AnomalyParent')
    const child = await createSession(
      handle,
      'AnomalyChild',
      undefined,
      undefined,
      'web',
      parent.id,
    )
    // 异常态：父已删、子仍活跃（删除级联与并发创建子会话的竞态可产生）。
    // 防御口径与 permanentlyDeleteSession「含未软删除的 fork 后代」一致。
    await softDeleteSession(handle, parent.id)
    await handle.db.update(sessions).set({ deletedAt: null }).where(eq(sessions.id, child.id))
    expect((await getSession(handle, child.id))?.deletedAt).toBeNull()
    const deleted = await emptyTrash(handle)
    expect(deleted).toBe(2)
    expect(await getSession(handle, parent.id)).toBeNull()
    expect(await getSession(handle, child.id)).toBeNull()
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
    // P1：清理方式为移入回收站（可恢复）而非物理删除——子 agent 会话在 Web 树可见，
    // 物理清除会绕过 60 天可恢复承诺。
    const trashedPrint = await getSession(handle, print.id)
    const trashedWf = await getSession(handle, wf.id)
    expect(trashedPrint?.deletedAt).not.toBeNull()
    expect(trashedWf?.deletedAt).not.toBeNull()
    expect(await getSession(handle, web.id)).not.toBeNull()
    expect(await getSession(handle, plainCli.id)).not.toBeNull()
    expect(await getSession(handle, recentPrint.id)).not.toBeNull()
    // 已在回收站的条目不被重复计数（幂等）
    expect(await purgeTemporarySessions(handle)).toBe(0)
  })

  it('临时会话清理级联子 agent 会话（同批次入回收站，可随父恢复）', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const wf = await createSession(handle, 'workflow:x', undefined, 'workflow')
    const child = await createSession(
      handle,
      'sub-agent',
      undefined,
      'researcher',
      undefined,
      wf.id,
    )
    await handle.db.update(sessions).set({ updatedAt: old }).where(eq(sessions.id, wf.id))
    const purged = await purgeTemporarySessions(handle)
    expect(purged).toBe(1)
    expect((await getSession(handle, child.id))?.deletedAt).not.toBeNull()
    // 恢复父会话连带恢复同批次后代
    const restored = await restoreSessionCore(handle, wf.id)
    expect(restored.restored).toBe(true)
    expect((await getSession(handle, child.id))?.deletedAt).toBeNull()
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

describe('permanentlyDeleteSession', () => {
  let handle: DB
  beforeEach(async () => {
    handle = await setupDB()
  })

  it('删除含分支后代的回收站会话（子先于父，自引用 FK 不违反）', async () => {
    const root = await createSession(handle, 'root')
    const child = await createSession(handle, 'branch', undefined, undefined, undefined, root.id)
    await softDeleteSession(handle, root.id)
    const deleted = await permanentlyDeleteSession(handle, root.id)
    expect(deleted).toBe(2)
    expect(await getSession(handle, root.id)).toBeNull()
    expect(await getSession(handle, child.id)).toBeNull()
  })

  it('回收站会话无后代时直接删除', async () => {
    const solo = await createSession(handle, 'solo')
    await softDeleteSession(handle, solo.id)
    expect(await permanentlyDeleteSession(handle, solo.id)).toBe(1)
    expect(await getSession(handle, solo.id)).toBeNull()
  })
})
