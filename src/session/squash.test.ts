import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { MessageContent } from '../shared/types/message.js'

// Hoisted flag controlling whether the mocked insertEntry throws. Hoisted so
// the (also hoisted) vi.mock factory below can close over it safely.
const failFlag = vi.hoisted(() => ({ failInsert: false }))

// Mock message.js: re-export every real function unchanged, except insertEntry,
// which throws when the flag is set. This injects a failure at the LAST write
// step inside squashRecent's transaction, proving the whole rewrite rolls back
// (delete + archive + summary) so message history is never lost on partial
// failure — the data-integrity risk this fix addresses.
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
    failFlag.failInsert = false
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  afterEach(async () => {
    failFlag.failInsert = false
    await handle.close()
  })

  // Seed `n` alternating user/assistant messages (msg-0 .. msg-(n-1)).
  async function seed(n: number) {
    for (let i = 0; i < n; i++) {
      await appendMessage(handle, sessionId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`msg-${i}`),
      })
    }
  }

  it('returns compacted:false with reason too_few_messages when not enough messages', async () => {
    // 3 < count(4) + keepRecent(2) = 6
    await seed(3)
    const result = await squashRecent(handle, sessionId, 4, async () => 'summary')
    expect(result).toEqual({ compacted: false, reason: 'too_few_messages' })
    // History is untouched.
    expect(await getMessages(handle, sessionId)).toHaveLength(3)
  })

  it('returns compacted:false with reason nothing_to_compact when toSquash is empty', async () => {
    // count(2) == keepRecent(2) -> toSquash window is empty, yet the guard
    // passes (4 >= 2 + 2).
    await seed(4)
    const result = await squashRecent(handle, sessionId, 2, async () => 'summary')
    expect(result).toEqual({ compacted: false, reason: 'nothing_to_compact' })
    expect(await getMessages(handle, sessionId)).toHaveLength(4)
  })

  it('squashes the middle window, deletes originals, and keeps the tail verbatim', async () => {
    // 6 messages, count=4, keepRecent=2 (default):
    //   squashStart = 6 - 4 = 2, tailStart = 6 - 2 = 4
    //   toSquash   = messages[2..4) -> 2 messages (msg-2, msg-3)
    //   keepTail   = messages[4..6) -> 2 messages (msg-4, msg-5)
    await seed(6)

    // The (slow, network) summarizer runs BEFORE the transaction opens — same
    // invariant as compactSession. Asserting it was invoked confirms it drove
    // the summary rather than being skipped.
    const summarizer = vi.fn(async (prompt: string) => `SUMMARY(${prompt.length})`)
    const result = await squashRecent(handle, sessionId, 4, summarizer)

    expect(result.compacted).toBe(true)
    if (result.compacted) {
      expect(result.summary).toContain('SUMMARY')
      expect(result.compactedCount).toBe(2) // toSquash.length
      expect(result.keptCount).toBe(2) // keepTail.length
      expect(result.archiveId).toBeTruthy()
      expect(result.fileSnapshots).toEqual([]) // no tool-call hot files in text-only msgs
    }
    expect(summarizer).toHaveBeenCalledTimes(1)

    // Squashed messages removed; prefix(2) + tail(2) = 4 messages remain.
    const remaining = await getMessages(handle, sessionId)
    expect(remaining).toHaveLength(4)
    expect(remaining[0]?.content[0]).toMatchObject({ _tag: 'text', text: 'msg-0' }) // prefix
    expect(remaining[2]?.content[0]).toMatchObject({ _tag: 'text', text: 'msg-4' }) // tail

    // A squash entry was committed, positioned before the kept tail.
    const entries = await getEntries(handle, sessionId)
    const squash = entries.find((e) => '_tag' in e && e._tag === 'squash')
    expect(squash).toBeDefined()
  })

  it('rolls back the whole rewrite when a write fails, leaving history intact', async () => {
    // Core data-integrity guarantee: if any write inside the transaction throws
    // (here insertEntry — the LAST step), the preceding deleteEntriesByIds must
    // be undone so messages are never lost. Without the transaction wrapper,
    // a failed insertEntry after a successful delete would permanently drop the
    // original messages while leaving no summary behind.
    await seed(6)
    expect(await getMessages(handle, sessionId)).toHaveLength(6)

    failFlag.failInsert = true
    await expect(
      squashRecent(handle, sessionId, 4, async () => 'will-never-persist'),
    ).rejects.toThrow('injected insertEntry failure')

    // Transaction rolled back: all 6 original messages survive, in order.
    const after = await getMessages(handle, sessionId)
    expect(after).toHaveLength(6)
    expect(after.map((m) => (m.content[0]?._tag === 'text' ? m.content[0].text : ''))).toEqual(
      Array.from({ length: 6 }, (_, i) => `msg-${i}`),
    )

    // No squash entry was committed.
    const entries = await getEntries(handle, sessionId)
    expect(entries.some((e) => '_tag' in e && e._tag === 'squash')).toBe(false)
  })

  it('stays atomic even when archiveOriginal is disabled (delete+insert only)', async () => {
    // archiveOriginal=false skips the archive write, but the remaining
    // delete+insert must still share one transaction: a failure rolls both back.
    await seed(6)

    failFlag.failInsert = true
    await expect(
      squashRecent(handle, sessionId, 4, async () => 'x', {
        archiveOriginal: false,
        preserveFileSnapshots: false,
      }),
    ).rejects.toThrow('injected insertEntry failure')

    // No archive, no summary — every original message intact.
    expect(await getMessages(handle, sessionId)).toHaveLength(6)
    const entries = await getEntries(handle, sessionId)
    expect(entries.some((e) => '_tag' in e && e._tag === 'squash')).toBe(false)
  })
})
