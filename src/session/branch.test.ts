import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { sessionEntries } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { MessageContent } from '../shared/types/message.js'
import { BranchPointOutOfRangeError, forkSession, getBranches, getTree } from './branch.js'
import { appendMessage, getEntries, getMessages, insertEntry } from './message.js'
import { createSession, listSessions, touchLastOpened } from './session.js'
import { getFileSnapshots, upsertFileSnapshot } from './snapshot.js'

// Hoisted flag 控制被 mock 的 insertEntry 是否抛错（fork 回滚用例注入中途失败）。
const failFlag = vi.hoisted(() => ({ failInsert: false }))

// Mock message.js：仅替换 insertEntry，其余原样透传。flag 开启时在事务中途
// （forked session 已建、条目复制开始处）抛错，证明 forkSession 整体回滚、
// 不残留半成品分支——沿用 squash.test.ts 的注入模式。
vi.mock('./message.js', async (importActual) => {
  const actual = await importActual<typeof import('./message.js')>()
  return {
    ...actual,
    insertEntry: vi.fn(async (handle: DB, values: Parameters<typeof actual.insertEntry>[1]) => {
      if (failFlag.failInsert) throw new Error('injected insertEntry failure')
      return actual.insertEntry(handle, values)
    }),
  }
})

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('branching', () => {
  let handle: DB

  beforeEach(async () => {
    failFlag.failInsert = false
    handle = await setupDB()
  })

  afterEach(async () => {
    failFlag.failInsert = false
    await handle.close()
  })

  it('forks a session copying messages up to the branch point', async () => {
    const parent = await createSession(handle, 'Parent')
    for (let i = 0; i < 5; i++) {
      await appendMessage(handle, parent.id, { role: 'user', content: textContent(`msg-${i}`) })
    }
    const forked = await forkSession(handle, parent.id, 2)
    expect(forked.parentId).toBe(parent.id)
    expect(forked.branchPoint).toBe(2)
    expect(forked.title).toContain('Parent')
  })

  it('forked session has the copied messages', async () => {
    const parent = await createSession(handle, 'Parent')
    for (let i = 0; i < 4; i++) {
      await appendMessage(handle, parent.id, { role: 'user', content: textContent(`msg-${i}`) })
    }
    const forked = await forkSession(handle, parent.id, 1)
    const forkedMessages = await getMessages(handle, forked.id)
    expect(forkedMessages).toHaveLength(2) // indices 0 and 1
    expect(forkedMessages[1]?.content[0]).toMatchObject({ text: 'msg-1' })
  })

  it('forked session includes a branch_summary entry', async () => {
    const parent = await createSession(handle, 'Parent')
    await appendMessage(handle, parent.id, { role: 'user', content: textContent('hi') })
    const forked = await forkSession(handle, parent.id, 0)
    const entries = await getEntries(handle, forked.id)
    const summary = entries.find((e) => '_tag' in e && e._tag === 'branch_summary')
    expect(summary).toBeDefined()
  })

  it('fork 复制分支点前的非 message 条目（tool 往返、compaction）', async () => {
    const parent = await createSession(handle, 'Parent')
    await appendMessage(handle, parent.id, { role: 'user', content: textContent('hi') })
    // 工具往返条目（steering 与 compaction 同样被复制）
    await insertEntry(handle, {
      id: generateId(),
      sessionId: parent.id,
      tag: 'steering',
      content: { text: 'use the task tool' },
    })
    await appendMessage(handle, parent.id, { role: 'user', content: textContent('second') })

    const forked = await forkSession(handle, parent.id, 1)
    const entries = await getEntries(handle, forked.id)
    // user + steering + user + branch_summary
    expect(entries).toHaveLength(4)
    const steering = entries.find((e) => '_tag' in e && e._tag === 'steering')
    expect(steering).toBeDefined()
    const msgs = entries.filter((e) => !('_tag' in e))
    expect(msgs).toHaveLength(2)
  })

  it('fork 复制源会话最新文件快照', async () => {
    const parent = await createSession(handle, 'Parent')
    await appendMessage(handle, parent.id, { role: 'user', content: textContent('hi') })
    await upsertFileSnapshot(handle, parent.id, 'a.ts', 'v1')
    await upsertFileSnapshot(handle, parent.id, 'a.ts', 'v2')

    const forked = await forkSession(handle, parent.id, 0)
    const snaps = await getFileSnapshots(handle, forked.id)
    const aSnaps = snaps.filter((s) => s.filePath === 'a.ts')
    // 仅复制最新版本
    expect(aSnaps).toHaveLength(1)
    expect(aSnaps[0]?.content).toBe('v2')
    expect(aSnaps[0]?.version).toBe(2)
  })

  it('throws when forking a non-existent session', async () => {
    await expect(forkSession(handle, 'nonexistent', 0)).rejects.toThrow()
  })

  it('getBranches returns child sessions', async () => {
    const parent = await createSession(handle, 'Parent')
    await appendMessage(handle, parent.id, { role: 'user', content: textContent('hi') })
    await forkSession(handle, parent.id, 0)
    await forkSession(handle, parent.id, 0)
    const branches = await getBranches(handle, parent.id)
    expect(branches).toHaveLength(2)
  })

  it('getTree builds a hierarchical tree', async () => {
    const root = await createSession(handle, 'Root')
    await appendMessage(handle, root.id, { role: 'user', content: textContent('hi') })
    const child = await forkSession(handle, root.id, 0)
    await forkSession(handle, child.id, 0) // grandchild
    const tree = await getTree(handle)
    expect(tree).toHaveLength(1) // one root
    expect(tree[0]?.children).toHaveLength(1)
    expect(tree[0]?.children[0]?.children).toHaveLength(1)
  })

  it('getTree 按最近打开时间降序排列', async () => {
    // 创建顺序：s1 → s2 → s3
    const s1 = await createSession(handle, 'S1')
    const s2 = await createSession(handle, 'S2')
    const s3 = await createSession(handle, 'S3')

    // 打开顺序：s3 → s1 → s2（s2 最近打开）
    await touchLastOpened(handle, s3.id)
    await touchLastOpened(handle, s1.id)
    await touchLastOpened(handle, s2.id)

    const tree = await getTree(handle)
    expect(tree).toHaveLength(3)
    // 期望顺序：s2（最近打开）→ s1 → s3
    expect(tree[0]?.session.id).toBe(s2.id)
    expect(tree[1]?.session.id).toBe(s1.id)
    expect(tree[2]?.session.id).toBe(s3.id)
  })

  it('getTree 未打开过的会话按 updatedAt 降序排在已打开之后', async () => {
    const s1 = await createSession(handle, 'S1')
    await createSession(handle, 'S2')
    await createSession(handle, 'S3')

    // 只有 s1 被打开过
    await touchLastOpened(handle, s1.id)

    const tree = await getTree(handle)
    expect(tree).toHaveLength(3)
    // s1 最近打开，排第一；s3、s2 未打开过按 updatedAt（创建时间）降序
    expect(tree[0]?.session.id).toBe(s1.id)
  })

  it('fork 中途失败整体回滚，不残留半成品分支', async () => {
    const parent = await createSession(handle, 'Parent')
    for (let i = 0; i < 3; i++) {
      await appendMessage(handle, parent.id, { role: 'user', content: textContent(`msg-${i}`) })
    }

    // 在事务中途（forked session 已建、条目复制开始处）注入 insertEntry 失败。
    // 无事务时将残留已建的 forked session + parentId 更新；包事务后必须整体回滚。
    failFlag.failInsert = true
    await expect(forkSession(handle, parent.id, 1)).rejects.toThrow('injected insertEntry failure')
    failFlag.failInsert = false

    // sessions 表无残留：仅源会话一条
    expect(await listSessions(handle)).toHaveLength(1)
    expect(await getBranches(handle, parent.id)).toHaveLength(0)
    // sessionEntries 无孤儿行：源会话 3 条消息原样保留
    const entryRows = await handle.db.select().from(sessionEntries)
    expect(entryRows).toHaveLength(3)
    expect(entryRows.every((r) => r.sessionId === parent.id)).toBe(true)
  })

  it('fork 分支点越界抛 BranchPointOutOfRangeError（区别于会话不存在）', async () => {
    const parent = await createSession(handle, 'Parent')
    await appendMessage(handle, parent.id, { role: 'user', content: textContent('hi') })

    // 超出上限：自定义错误类型 + 明确 message，供路由映射 400 而非 404
    await expect(forkSession(handle, parent.id, 5)).rejects.toBeInstanceOf(
      BranchPointOutOfRangeError,
    )
    await expect(forkSession(handle, parent.id, 5)).rejects.toThrow(/out of range/)
    // 负数同样越界（msgEntries[-1] 为 undefined）
    await expect(forkSession(handle, parent.id, -1)).rejects.toThrow(BranchPointOutOfRangeError)

    const e = (await forkSession(handle, parent.id, 99).catch((err: unknown) => err)) as Error
    expect(e.name).toBe('BranchPointOutOfRangeError')
    expect(e.message).toContain('99')
  })
})
