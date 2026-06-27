import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { MessageContent } from '../shared/types/message.js'
import { appendMessage, getEntries, getMessages } from './message.js'
import { createSession } from './session.js'
import { squashRecent } from './squash.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('squashRecent', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('returns compacted:false when too few messages', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('one') })
    const result = await squashRecent(handle, sessionId, 3, async () => 'squash summary', {
      keepRecent: 2,
      preserveFileSnapshots: false,
      archiveOriginal: true,
    })
    expect(result.compacted).toBe(false)
  })

  it('squashes recent interactions into a summary entry', async () => {
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`msg-${i}`),
      })
    }
    const result = await squashRecent(handle, sessionId, 4, async () => 'squashed!', {
      keepRecent: 2,
      preserveFileSnapshots: false,
      archiveOriginal: true,
    })
    expect(result.compacted).toBe(true)
    if (result.compacted) {
      expect(result.summary).toBe('squashed!')
      expect(result.archiveId).toBeTruthy()
    }
  })

  it('leaves a squash entry in the session', async () => {
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`msg-${i}`),
      })
    }
    await squashRecent(handle, sessionId, 4, async () => 'summary', {
      keepRecent: 2,
      preserveFileSnapshots: false,
      archiveOriginal: true,
    })
    const entries = await getEntries(handle, sessionId)
    const squash = entries.find((e) => '_tag' in e && e._tag === 'squash')
    expect(squash).toBeDefined()
  })

  it('keeps prefix and tail messages after the squash entry', async () => {
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`msg-${i}`),
      })
    }
    await squashRecent(handle, sessionId, 4, async () => 'summary', {
      keepRecent: 2,
      preserveFileSnapshots: false,
      archiveOriginal: true,
    })
    // prefix (2) + tail (2) = 4 messages remain; squashed middle is replaced by entry
    const remaining = await getMessages(handle, sessionId)
    expect(remaining).toHaveLength(4)
  })
})
