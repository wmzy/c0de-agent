import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { ChatMessage } from '../shared/types/llm.js'
import type { Message, MessageContent } from '../shared/types/message.js'
import {
  entriesToChatMessages,
  getSessionContext,
  injectSnapshots,
  messageToChatMessage,
} from './context.js'
import { appendMessage, insertEntry } from './message.js'
import { createSession } from './session.js'
import { upsertFileSnapshot } from './snapshot.js'
import type { FileSnapshot } from './types.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('messageToChatMessage', () => {
  it('converts a text message to a ChatMessage', () => {
    const msg: Message = {
      id: 'm1',
      sessionId: 's',
      role: 'user',
      content: textContent('hello'),
      tokenCount: 1,
      createdAt: 0,
    }
    const chat = messageToChatMessage(msg)
    expect(chat.role).toBe('user')
    expect(typeof chat.content).toBe('string')
    expect(chat.content).toContain('hello')
  })

  it('includes tool_calls in assistant messages', () => {
    const msg: Message = {
      id: 'm1',
      sessionId: 's',
      role: 'assistant',
      content: [
        { _tag: 'text', text: 'let me read' },
        { _tag: 'tool_call', id: 'c1', tool: 'read', input: { path: '/a.ts' } },
      ],
      tokenCount: 1,
      createdAt: 0,
    }
    const chat = messageToChatMessage(msg)
    expect(chat.toolCalls).toBeDefined()
    expect(chat.toolCalls).toHaveLength(1)
    expect(chat.toolCalls?.[0]?.name).toBe('read')
  })

  it('maps tool_result messages with toolCallId', () => {
    const msg: Message = {
      id: 'm1',
      sessionId: 's',
      role: 'tool',
      content: [
        {
          _tag: 'tool_result',
          id: 'c1',
          tool: 'read',
          output: { _tag: 'success', output: 'data' },
        },
      ],
      tokenCount: 1,
      createdAt: 0,
    }
    const chat = messageToChatMessage(msg)
    expect(chat.role).toBe('tool')
    expect(chat.toolCallId).toBe('c1')
  })
})

describe('entriesToChatMessages', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('converts messages and special entries to ChatMessage[]', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('question') })
    await insertEntry(handle, {
      sessionId,
      tag: 'steering',
      content: { text: 'Be concise' },
    })
    await appendMessage(handle, sessionId, { role: 'assistant', content: textContent('answer') })

    const { entries } = await getSessionContext(handle, sessionId)
    const messages = entriesToChatMessages(entries, [])
    expect(messages).toHaveLength(3)
    expect(messages[1]?.role).toBe('system')
    expect(messages[1]?.content).toContain('Be concise')
  })

  it('renders compaction entries as system messages', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('old') })
    await insertEntry(handle, {
      sessionId,
      tag: 'compaction',
      content: { summary: 'past summary', originalEntryIds: [], archiveId: 'a1' },
      tokenCount: 5,
    })
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('new') })

    const { entries } = await getSessionContext(handle, sessionId)
    const messages = entriesToChatMessages(entries, [])
    const systemMsg = messages.find(
      (m) => m.role === 'system' && (m.content as string).includes('past summary'),
    )
    expect(systemMsg).toBeDefined()
  })
})

describe('injectSnapshots', () => {
  it('injects file snapshot block after the first message', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hi' },
    ]
    const snapshots: FileSnapshot[] = [
      {
        id: 's1',
        sessionId: 'x',
        filePath: '/a.ts',
        content: 'const x = 1',
        contentHash: 'h',
        tokenCount: 1,
        version: 1,
        createdAt: 0,
      },
    ]
    const result = injectSnapshots(messages, snapshots)
    expect(result).toHaveLength(3)
    expect(result[0]?.content).toBe('system prompt')
    expect(result[1]?.role).toBe('system')
    expect(result[1]?.content as string).toContain('/a.ts')
    expect(result[1]?.content as string).toContain('const x = 1')
  })

  it('returns messages unchanged when no snapshots', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
    expect(injectSnapshots(messages, [])).toBe(messages)
  })
})

describe('getSessionContext', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('returns entries and snapshots', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('hi') })
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'content')
    const { entries, snapshots } = await getSessionContext(handle, sessionId)
    expect(entries.length).toBeGreaterThan(0)
    expect(snapshots).toHaveLength(1)
  })
})
