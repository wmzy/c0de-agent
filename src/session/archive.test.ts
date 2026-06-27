import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { generateId } from '../shared/index.js'
import type { MessageContent } from '../shared/types/message.js'
import {
  archiveOriginalEntries,
  getArchive,
  getArchiveOriginalEntries,
  parseArchiveReference,
  resolveArchiveReference,
  searchArchives,
} from './archive.js'
import { appendMessage } from './message.js'
import { createSession } from './session.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('archives', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('archives entries and returns an archive id', async () => {
    const msg = await appendMessage(handle, sessionId, {
      role: 'user',
      content: textContent('hello world'),
    })
    const archiveId = await archiveOriginalEntries(
      handle,
      sessionId,
      [msg],
      'compaction',
      'Summary text',
      generateId(),
    )
    expect(archiveId).toBeTruthy()
  })

  it('retrieves an archive by id', async () => {
    const msg = await appendMessage(handle, sessionId, {
      role: 'user',
      content: textContent('content'),
    })
    const archiveId = await archiveOriginalEntries(
      handle,
      sessionId,
      [msg],
      'compaction',
      'My summary',
      generateId(),
    )
    const archive = await getArchive(handle, archiveId)
    expect(archive?.summary).toBe('My summary')
    expect(archive?.archiveType).toBe('compaction')
  })

  it('returns null for non-existent archive', async () => {
    const archive = await getArchive(handle, '00000000-0000-0000-0000-000000000000')
    expect(archive).toBeNull()
  })

  it('gets original entries from an archive', async () => {
    const msg = await appendMessage(handle, sessionId, {
      role: 'user',
      content: textContent('original'),
    })
    const archiveId = await archiveOriginalEntries(
      handle,
      sessionId,
      [msg],
      'compaction',
      'summary',
      generateId(),
    )
    const originals = await getArchiveOriginalEntries(handle, archiveId)
    expect(originals).toHaveLength(1)
  })

  it('searches archives by keyword', async () => {
    const msg1 = await appendMessage(handle, sessionId, {
      role: 'user',
      content: textContent('alpha beta'),
    })
    const msg2 = await appendMessage(handle, sessionId, {
      role: 'user',
      content: textContent('gamma delta'),
    })
    await archiveOriginalEntries(
      handle,
      sessionId,
      [msg1],
      'compaction',
      'alpha summary',
      generateId(),
    )
    await archiveOriginalEntries(
      handle,
      sessionId,
      [msg2],
      'compaction',
      'gamma summary',
      generateId(),
    )
    const results = await searchArchives(handle, sessionId, 'alpha')
    expect(results).toHaveLength(1)
    expect(results[0]?.summary).toContain('alpha')
  })
})

describe('parseArchiveReference', () => {
  it('parses @[archive:<id>]', () => {
    expect(parseArchiveReference('see @[archive:abc-123]')).toEqual({
      type: 'archive',
      id: 'abc-123',
    })
  })

  it('parses @[squash:<n>]', () => {
    expect(parseArchiveReference('ref @[squash:2]')).toEqual({ type: 'squash', id: '2' })
  })

  it('parses @[squash:last]', () => {
    expect(parseArchiveReference('ref @[squash:last]')).toEqual({ type: 'squash', id: 'last' })
  })

  it('returns null when no reference found', () => {
    expect(parseArchiveReference('no references here')).toBeNull()
  })
})

describe('resolveArchiveReference', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('resolves an archive reference to summary text', async () => {
    const msg = await appendMessage(handle, sessionId, {
      role: 'user',
      content: textContent('data'),
    })
    const archiveId = await archiveOriginalEntries(
      handle,
      sessionId,
      [msg],
      'compaction',
      'Resolved summary',
      generateId(),
    )
    const text = await resolveArchiveReference(handle, sessionId, {
      type: 'archive',
      id: archiveId,
    })
    expect(text).toContain('Resolved summary')
  })

  it('returns null for missing archive', async () => {
    const text = await resolveArchiveReference(handle, sessionId, {
      type: 'archive',
      id: 'missing',
    })
    expect(text).toBeNull()
  })
})
