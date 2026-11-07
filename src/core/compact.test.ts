import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createTestDB, resetTestDB } from '../db/test-utils.js'
import { compactSession } from '../session/compaction.js'
import { appendMessage } from '../session/message.js'
import { createSession } from '../session/session.js'

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

describe('compactSession', () => {
  it('runs with the provided summarizer and returns result', async () => {
    const db = dbHandle
    const session = await createSession(db, 'test')
    await appendMessage(db, session.id, {
      role: 'user',
      content: [{ _tag: 'text', text: 'Hello world '.repeat(100) }],
    })
    await appendMessage(db, session.id, {
      role: 'assistant',
      content: [{ _tag: 'text', text: 'Hi there '.repeat(100) }],
    })
    await appendMessage(db, session.id, {
      role: 'user',
      content: [{ _tag: 'text', text: 'Another message '.repeat(100) }],
    })
    await appendMessage(db, session.id, {
      role: 'assistant',
      content: [{ _tag: 'text', text: 'Response here '.repeat(100) }],
    })

    const summarizer = async () => 'Compacted summary'
    const result = await compactSession(db, session.id, summarizer, { keepRecentTokens: 0 })
    expect(result.compacted).toBe(true)
    if (result.compacted) {
      expect(result.summary).toBe('Compacted summary')
      expect(result.archiveId).toBeTruthy()
    }
  })
})
