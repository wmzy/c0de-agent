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

  it('丢弃空 id 的 tool_call 和无法配对的孤儿 tool result', async () => {
    // 模拟部分 provider 的违规输出：assistant 含空 id 的 tool_call 碎片，
    // tool result 含空 toolCallId 或找不到对应 tool_call。
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('hi') })
    // assistant：一个有效 tool_call + 一个空 id 碎片
    await appendMessage(handle, sessionId, {
      role: 'assistant',
      content: [
        ...textContent('let me check'),
        { _tag: 'tool_call', id: 'call_valid', tool: 'read', input: { path: 'a.ts' } },
        { _tag: 'tool_call', id: '', tool: '', input: { _parseError: 'x', _raw: '{bad' } },
      ],
    })
    // 有效 tool result（配对 call_valid）
    await appendMessage(handle, sessionId, {
      role: 'tool',
      content: [
        {
          _tag: 'tool_result',
          id: 'call_valid',
          tool: 'read',
          output: { _tag: 'success', output: 'data' },
        },
      ],
    })
    // 孤儿 tool result（空 toolCallId）
    await appendMessage(handle, sessionId, {
      role: 'tool',
      content: [{ _tag: 'tool_result', id: '', tool: '', output: { _tag: 'error', error: 'bad' } }],
    })
    // 孤儿 tool result（toolCallId 不匹配任何 tool_call）
    await appendMessage(handle, sessionId, {
      role: 'tool',
      content: [
        {
          _tag: 'tool_result',
          id: 'call_ghost',
          tool: 'read',
          output: { _tag: 'success', output: 'x' },
        },
      ],
    })

    const { entries } = await getSessionContext(handle, sessionId)
    const messages = entriesToChatMessages(entries, [])

    const assistant = messages.find((m) => m.role === 'assistant' && m.toolCalls)
    expect(assistant?.toolCalls).toHaveLength(1)
    expect(assistant?.toolCalls?.[0]?.id).toBe('call_valid')

    const toolMsgs = messages.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0]?.toolCallId).toBe('call_valid')
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

  it('deduplicates snapshot versions to latest per file', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hi' },
    ]
    const snapshots: FileSnapshot[] = [
      {
        id: 's1',
        sessionId: 'x',
        filePath: '/a.ts',
        content: 'v1',
        contentHash: 'h1',
        tokenCount: 1,
        version: 1,
        createdAt: 0,
      },
      {
        id: 's2',
        sessionId: 'x',
        filePath: '/a.ts',
        content: 'v2',
        contentHash: 'h2',
        tokenCount: 1,
        version: 2,
        createdAt: 1,
      },
      {
        id: 's3',
        sessionId: 'x',
        filePath: '/b.ts',
        content: 'b1',
        contentHash: 'h3',
        tokenCount: 1,
        version: 1,
        createdAt: 0,
      },
    ]
    const result = injectSnapshots(messages, snapshots)
    const block = result[1]?.content as string
    expect(block).toContain('v2')
    expect(block).not.toContain('v1')
    expect(block).toContain('b1')
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

describe('messageToChatMessage 多模态', () => {
  const base = (content: Message['content']): Message => ({
    id: 'm1',
    sessionId: 's',
    role: 'user',
    content,
    tokenCount: 0,
    createdAt: 1,
  })

  it('无 image 时返回纯字符串 content（原路径）', () => {
    const chat = messageToChatMessage(base([{ _tag: 'text', text: 'hi' }]))
    expect(typeof chat.content).toBe('string')
    expect(chat.content).toBe('hi')
  })

  it('含 image 时返回 ContentPart 数组', () => {
    const chat = messageToChatMessage(
      base([
        { _tag: 'text', text: '看这张图' },
        { _tag: 'image', mediaType: 'image/png', data: 'BASE64' },
      ]),
    )
    expect(Array.isArray(chat.content)).toBe(true)
    const parts = chat.content as Array<{ type: string; [k: string]: unknown }>
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: 'text', text: '看这张图' })
    expect(parts[1]).toEqual({ type: 'image', mediaType: 'image/png', data: 'BASE64' })
  })

  it('仅 image 无 text 时数组只含 image part', () => {
    const chat = messageToChatMessage(
      base([{ _tag: 'image', mediaType: 'image/png', data: 'X' }]),
    )
    const parts = chat.content as Array<{ type: string }>
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('image')
  })
})
