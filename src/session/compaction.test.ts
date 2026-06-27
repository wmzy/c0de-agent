import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { Message, MessageContent } from '../shared/types/message.js'
import {
  buildCompactionPrompt,
  compactSession,
  extractHotFiles,
  findSafeCutPoint,
} from './compaction.js'
import { appendMessage, getEntries, getMessages } from './message.js'
import { createSession } from './session.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]
const mk = (role: 'user' | 'assistant', text: string): Message => ({
  id: `m-${text}`,
  sessionId: 's',
  role,
  content: textContent(text),
  tokenCount: 1,
  createdAt: 0,
})

describe('findSafeCutPoint', () => {
  it('cuts at the start of a user turn at or before the preferred cut', () => {
    const messages = [
      mk('user', 'turn1'),
      mk('assistant', 'reply1'),
      mk('user', 'turn2'),
      mk('assistant', 'reply2'),
      mk('user', 'turn3'),
      mk('assistant', 'reply3'),
    ]
    expect(findSafeCutPoint(messages, 4)).toBe(4)
  })

  it('returns 0 when preferredCut is 0 (nothing to compact)', () => {
    const messages = [mk('assistant', 'a'), mk('user', 'u')]
    expect(findSafeCutPoint(messages, 0)).toBe(0)
  })

  it('returns 0 when no user turn exists at or before cut', () => {
    const messages = [mk('assistant', 'a'), mk('assistant', 'b')]
    expect(findSafeCutPoint(messages, 1)).toBe(0)
  })
})

describe('extractHotFiles', () => {
  it('returns files accessed multiple times with latest content', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        sessionId: 's',
        role: 'assistant',
        content: [{ _tag: 'tool_call', id: 'c1', tool: 'read', input: { path: '/a.ts' } }],
        tokenCount: 1,
        createdAt: 0,
      },
      {
        id: 'm2',
        sessionId: 's',
        role: 'tool',
        content: [
          {
            _tag: 'tool_result',
            id: 'c1',
            tool: 'read',
            output: { _tag: 'success', output: 'content-a' },
          },
        ],
        tokenCount: 1,
        createdAt: 1,
      },
      {
        id: 'm3',
        sessionId: 's',
        role: 'assistant',
        content: [{ _tag: 'tool_call', id: 'c2', tool: 'read', input: { path: '/a.ts' } }],
        tokenCount: 1,
        createdAt: 2,
      },
      {
        id: 'm4',
        sessionId: 's',
        role: 'tool',
        content: [
          {
            _tag: 'tool_result',
            id: 'c2',
            tool: 'read',
            output: { _tag: 'success', output: 'content-a-v2' },
          },
        ],
        tokenCount: 1,
        createdAt: 3,
      },
    ]
    const hot = extractHotFiles(messages)
    expect(hot).toHaveLength(1)
    expect(hot[0]?.path).toBe('/a.ts')
    expect(hot[0]?.content).toBe('content-a-v2')
    expect(hot[0]?.accessCount).toBe(2)
  })

  it('ignores files accessed only once', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        sessionId: 's',
        role: 'assistant',
        content: [{ _tag: 'tool_call', id: 'c1', tool: 'read', input: { path: '/once.ts' } }],
        tokenCount: 1,
        createdAt: 0,
      },
    ]
    expect(extractHotFiles(messages)).toHaveLength(0)
  })
})

describe('buildCompactionPrompt', () => {
  it('includes section headers and entry content', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        sessionId: 's',
        role: 'user',
        content: textContent('do something'),
        tokenCount: 1,
        createdAt: 0,
      },
      {
        id: 'm2',
        sessionId: 's',
        role: 'assistant',
        content: textContent('done'),
        tokenCount: 1,
        createdAt: 1,
      },
    ]
    const prompt = buildCompactionPrompt(messages)
    expect(prompt).toContain('## Goal')
    expect(prompt).toContain('## Progress')
    expect(prompt).toContain('do something')
    expect(prompt).toContain('done')
  })
})

describe('compactSession', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('returns compacted:false when too few messages', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('only one') })
    const result = await compactSession(handle, sessionId, async () => 'summary', { keepRecent: 6 })
    expect(result.compacted).toBe(false)
  })

  it('compacts old messages and keeps recent ones', async () => {
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`msg-${i}`),
      })
    }
    const result = await compactSession(
      handle,
      sessionId,
      async (prompt) => `SUMMARY: ${prompt.slice(0, 20)}`,
      {
        keepRecent: 2,
      },
    )
    expect(result.compacted).toBe(true)
    if (result.compacted) {
      expect(result.summary).toContain('SUMMARY')
      expect(result.compactedCount).toBeGreaterThan(0)
      expect(result.keptCount).toBe(2)
      expect(result.archiveId).toBeTruthy()
    }
  })

  it('leaves a compaction entry after compacted messages', async () => {
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`msg-${i}`),
      })
    }
    await compactSession(handle, sessionId, async () => 'compacted summary', { keepRecent: 2 })
    const entries = await getEntries(handle, sessionId)
    const compaction = entries.find((e) => '_tag' in e && e._tag === 'compaction')
    expect(compaction).toBeDefined()
  })

  it('removes compacted messages from the session', async () => {
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`msg-${i}`),
      })
    }
    await compactSession(handle, sessionId, async () => 'summary', { keepRecent: 2 })
    const remaining = await getMessages(handle, sessionId)
    expect(remaining).toHaveLength(2)
  })

  it('places the compaction summary before kept messages in chronological order', async () => {
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`msg-${i}`),
      })
    }
    await compactSession(handle, sessionId, async () => 'compaction summary', { keepRecent: 2 })
    const entries = await getEntries(handle, sessionId)
    // Compaction summary must come FIRST, then the kept messages
    const first = entries[0]
    expect(first && '_tag' in first && first._tag).toBe('compaction')
    const rest = entries.slice(1)
    expect(rest.every((e) => !('_tag' in e))).toBe(true)
  })
})
