import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { MessageContent } from '../shared/types/message.js'
import { appendMessage, getEntries, getMessages } from './message.js'
import { createSession } from './session.js'
import { forkSession, getBranches, getTree } from './branch.js'

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
})
