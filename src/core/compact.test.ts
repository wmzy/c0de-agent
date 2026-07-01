import { describe, expect, it } from 'vitest'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { appendMessage } from '../session/message.js'
import { createSession } from '../session/session.js'
import { runCompaction } from './compact.js'

describe('runCompaction', () => {
  it('calls compactSession with the summarizer and returns result', async () => {
    const db = await createDB({ driver: 'pglite' })
    await migrateDB(db)
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
    const result = await runCompaction(db, session.id, summarizer, { keepRecentTokens: 0 })
    expect(result.compacted).toBe(true)
    if (result.compacted) {
      expect(result.summary).toBe('Compacted summary')
      expect(result.archiveId).toBeTruthy()
    }
    await db.close()
  })
})
