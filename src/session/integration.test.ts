import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { MessageContent } from '../shared/types/message.js'
import {
  appendMessage,
  compactSession,
  createSession,
  entriesToChatMessages,
  forkSession,
  getEntries,
  getMessages,
  getSessionContext,
  searchArchives,
  squashRecent,
} from './index.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('session integration', () => {
  let handle: DB

  beforeEach(async () => {
    handle = await setupDB()
  })

  it('full lifecycle: create → chat → compact → branch → squash', async () => {
    const session = await createSession(handle, 'Integration Test')

    for (let i = 0; i < 8; i++) {
      await appendMessage(handle, session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`message number ${i}`),
      })
    }
    expect(await getMessages(handle, session.id)).toHaveLength(8)

    const compactResult = await compactSession(
      handle,
      session.id,
      async (p) => `SUMMARY(${p.length})`,
      {
        keepRecent: 4,
      },
    )
    expect(compactResult.compacted).toBe(true)

    const entries = await getEntries(handle, session.id)
    const hasCompaction = entries.some((e) => '_tag' in e && e._tag === 'compaction')
    expect(hasCompaction).toBe(true)

    if (compactResult.compacted) {
      const results = await searchArchives(handle, session.id, 'message')
      expect(results.length).toBeGreaterThan(0)
    }

    await appendMessage(handle, session.id, {
      role: 'user',
      content: textContent('after compaction'),
    })

    const forked = await forkSession(handle, session.id, 0)
    expect(forked.parentId).toBe(session.id)

    const { entries: ctxEntries, snapshots } = await getSessionContext(handle, session.id)
    const chatMessages = entriesToChatMessages(ctxEntries, snapshots)
    expect(chatMessages.length).toBeGreaterThan(0)
    const hasCompactionMsg = chatMessages.some(
      (m) => m.role === 'system' && (m.content as string).includes('Compacted History'),
    )
    expect(hasCompactionMsg).toBe(true)
  })

  it('squash then reconstruct context', async () => {
    const session = await createSession(handle, 'Squash Test')
    for (let i = 0; i < 8; i++) {
      await appendMessage(handle, session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`turn ${i}`),
      })
    }

    const result = await squashRecent(handle, session.id, 4, async () => 'squashed turn', {
      keepRecent: 2,
      preserveFileSnapshots: false,
      archiveOriginal: true,
    })
    expect(result.compacted).toBe(true)

    const { entries } = await getSessionContext(handle, session.id)
    const hasSquash = entries.some((e) => '_tag' in e && e._tag === 'squash')
    expect(hasSquash).toBe(true)

    // prefix (4) + tail (2) = 6 messages
    expect(await getMessages(handle, session.id)).toHaveLength(6)
  })

  it('handles concurrent sessions independently', async () => {
    const s1 = await createSession(handle, 'Session 1')
    const s2 = await createSession(handle, 'Session 2')

    await appendMessage(handle, s1.id, { role: 'user', content: textContent('in s1') })
    await appendMessage(handle, s2.id, { role: 'user', content: textContent('in s2') })

    expect(await getMessages(handle, s1.id)).toHaveLength(1)
    expect(await getMessages(handle, s2.id)).toHaveLength(1)
    expect((await getMessages(handle, s1.id))[0]?.content[0]).toMatchObject({ text: 'in s1' })
  })
})
