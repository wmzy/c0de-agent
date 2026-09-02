import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// Hoisted flag 控制被 mock 的 upsertFileSnapshot 是否抛错（DB 写入错误上抛用例）。
const failFlag = vi.hoisted(() => ({ failUpsert: false }))

// Mock snapshot.js：仅替换 upsertFileSnapshot，其余原样透传。refreshStaleSnapshots
// 的 catch 只允许吞 fs 错误（stat/readFile）；注入 upsertFileSnapshot 抛错可证明
// DB 写入错误不再被吞掉、过期内容不再静默注入上下文。
vi.mock('./snapshot.js', async (importActual) => {
  const actual = await importActual<typeof import('./snapshot.js')>()
  return {
    ...actual,
    upsertFileSnapshot: vi.fn(
      async (
        handle: DB,
        sessionId: string,
        filePath: string,
        content: string,
        mtimeMs?: number,
      ) => {
        if (failFlag.failUpsert) throw new Error('injected db write failure')
        return actual.upsertFileSnapshot(handle, sessionId, filePath, content, mtimeMs)
      },
    ),
  }
})

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

  it('为无 result 的 tool_call 注入合成 tool result（服务中断场景）', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('hi') })
    // assistant 有 tool_call 但无对应 tool result（服务重启中断）
    await appendMessage(handle, sessionId, {
      role: 'assistant',
      content: [
        ...textContent('let me check'),
        { _tag: 'tool_call', id: 'call_orphan', tool: 'read', input: { path: 'a.ts' } },
      ],
    })

    const { entries } = await getSessionContext(handle, sessionId)
    const messages = entriesToChatMessages(entries, [])

    const assistant = messages.find((m) => m.role === 'assistant' && m.toolCalls)
    expect(assistant?.toolCalls).toHaveLength(1)
    expect(assistant?.toolCalls?.[0]?.id).toBe('call_orphan')

    // 合成 tool result 注入
    const toolMsgs = messages.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0]?.toolCallId).toBe('call_orphan')
    expect(toolMsgs[0]?.content).toContain('interrupted')
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
    failFlag.failUpsert = false
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  afterEach(async () => {
    failFlag.failUpsert = false
    await handle.close()
  })

  it('returns entries and snapshots', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('hi') })
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'content')
    const { entries, snapshots } = await getSessionContext(handle, sessionId)
    expect(entries.length).toBeGreaterThan(0)
    expect(snapshots).toHaveLength(1)
  })

  it('cwd 提供时过期快照自动重读并升版本', async () => {
    const tmpCwd = await mkdtemp(join(tmpdir(), 'c0de-stale-'))
    const filePath = 'note.txt'
    const abs = join(tmpCwd, filePath)
    await writeFile(abs, 'v1')
    const st1 = await stat(abs)
    // 模拟旧快照：mtime 早于磁盘当前值
    await upsertFileSnapshot(handle, sessionId, filePath, 'stale', st1.mtimeMs - 10_000)

    await writeFile(abs, 'v2')
    const { snapshots } = await getSessionContext(handle, sessionId, tmpCwd)

    const latest = snapshots
      .filter((s) => s.filePath === filePath)
      .sort((a, b) => b.version - a.version)[0]
    expect(latest?.content).toBe('v2')
    expect(latest?.version).toBe(2)

    await rm(tmpCwd, { recursive: true, force: true })
  })

  it('未过期的快照不重复重读', async () => {
    const tmpCwd = await mkdtemp(join(tmpdir(), 'c0de-fresh-'))
    const filePath = 'note.txt'
    await writeFile(join(tmpCwd, filePath), 'same')
    const st1 = await stat(join(tmpCwd, filePath))
    await upsertFileSnapshot(handle, sessionId, filePath, 'same', st1.mtimeMs)

    const { snapshots } = await getSessionContext(handle, sessionId, tmpCwd)
    const versions = snapshots.filter((s) => s.filePath === filePath).map((s) => s.version)
    expect(versions).toEqual([1])

    await rm(tmpCwd, { recursive: true, force: true })
  })

  it('刷新过期快照时 DB 写入错误向上抛，而非静默注入过期内容', async () => {
    const tmpCwd = await mkdtemp(join(tmpdir(), 'c0de-dbfail-'))
    const filePath = 'note.txt'
    const abs = join(tmpCwd, filePath)
    await writeFile(abs, 'v1')
    const st1 = await stat(abs)
    // 旧快照 mtime 早于磁盘 → 判定过期，进入刷新写入路径
    await upsertFileSnapshot(handle, sessionId, filePath, 'stale', st1.mtimeMs - 10_000)
    await writeFile(abs, 'v2')

    failFlag.failUpsert = true
    // 修复前：upsertFileSnapshot 的 DB 错误被 catch 一并吞掉，静默返回过期内容；
    // 修复后：fs 错误照旧跳过，DB 写入错误必须向上抛给调用方。
    await expect(getSessionContext(handle, sessionId, tmpCwd)).rejects.toThrow(
      'injected db write failure',
    )
    failFlag.failUpsert = false

    await rm(tmpCwd, { recursive: true, force: true })
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
    const chat = messageToChatMessage(base([{ _tag: 'image', mediaType: 'image/png', data: 'X' }]))
    const parts = chat.content as Array<{ type: string }>
    expect(parts).toHaveLength(1)
    expect(parts[0]?.type).toBe('image')
  })
})
