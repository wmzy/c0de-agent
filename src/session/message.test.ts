import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { MessageContent } from '../shared/types/message.js'
import { appendMessage, deleteMessagesAfter, getMessageCount, getMessages } from './message.js'
import { createSession } from './session.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('message operations', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    const session = await createSession(handle, 'Test')
    sessionId = session.id
  })

  it('appends a message and returns it with generated id/timestamp', async () => {
    const msg = await appendMessage(handle, sessionId, {
      role: 'user',
      content: textContent('Hello'),
    })
    expect(msg.id).toBeTruthy()
    expect(msg.sessionId).toBe(sessionId)
    expect(msg.role).toBe('user')
    expect(msg.content).toEqual(textContent('Hello'))
    expect(msg.tokenCount).toBeGreaterThan(0)
    expect(msg.createdAt).toBeGreaterThan(0)
  })

  it('preserves explicit tokenCount when provided', async () => {
    const msg = await appendMessage(handle, sessionId, {
      role: 'user',
      content: textContent('Hi'),
      tokenCount: 42,
    })
    expect(msg.tokenCount).toBe(42)
  })

  it('stores tool_call and tool_result content parts', async () => {
    const content: MessageContent[] = [
      { _tag: 'tool_call', id: 'call-1', tool: 'read', input: { path: '/a.ts' } },
    ]
    const msg = await appendMessage(handle, sessionId, { role: 'assistant', content })
    expect(msg.content[0]?._tag).toBe('tool_call')
  })

  it('retrieves messages in insertion order', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('first') })
    await appendMessage(handle, sessionId, { role: 'assistant', content: textContent('second') })
    const messages = await getMessages(handle, sessionId)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.content[0]).toMatchObject({ text: 'first' })
    expect(messages[1]?.content[0]).toMatchObject({ text: 'second' })
  })

  it('counts messages', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('a') })
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('b') })
    expect(await getMessageCount(handle, sessionId)).toBe(2)
  })

  it('respects limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await appendMessage(handle, sessionId, { role: 'user', content: textContent(`msg-${i}`) })
    }
    const page = await getMessages(handle, sessionId, { limit: 2, offset: 1 })
    expect(page).toHaveLength(2)
    expect(page[0]?.content[0]).toMatchObject({ text: 'msg-1' })
  })

  it('deletes messages after a given index', async () => {
    for (let i = 0; i < 4; i++) {
      await appendMessage(handle, sessionId, { role: 'user', content: textContent(`msg-${i}`) })
    }
    await deleteMessagesAfter(handle, sessionId, 1) // keep 0,1; delete 2,3
    const remaining = await getMessages(handle, sessionId)
    expect(remaining).toHaveLength(2)
    expect(remaining[1]?.content[0]).toMatchObject({ text: 'msg-1' })
  })
})
