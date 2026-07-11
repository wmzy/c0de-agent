import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { MessageContent } from '../shared/types/message.js'
import { forkSession, getBranches, getTree } from './branch.js'
import { appendMessage, getEntries, getMessages } from './message.js'
import { createSession, touchLastOpened } from './session.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('branching', () => {
  let handle: DB

  beforeEach(async () => {
    handle = await setupDB()
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
})
