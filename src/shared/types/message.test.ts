import { describe, expect, it } from 'vitest'
import type { Message, MessageContent, Session, SessionMetadata } from './message.js'

describe('MessageContent', () => {
  it('creates a text content part', () => {
    const part: MessageContent = { _tag: 'text', text: 'hello world' }
    expect(part._tag).toBe('text')
  })

  it('creates a tool_call content part', () => {
    const part: MessageContent = {
      _tag: 'tool_call',
      id: 'tc-1',
      tool: 'read',
      input: { path: 'src/main.ts' },
    }
    expect(part._tag).toBe('tool_call')
  })

  it('creates a tool_result content part', () => {
    const part: MessageContent = {
      _tag: 'tool_result',
      id: 'tc-1',
      tool: 'read',
      output: { _tag: 'success', output: 'file contents' },
    }
    expect(part._tag).toBe('tool_result')
  })

  it('creates a thinking content part', () => {
    const part: MessageContent = { _tag: 'thinking', text: 'Let me analyze...' }
    expect(part._tag).toBe('thinking')
  })

  it('creates a steering content part', () => {
    const part: MessageContent = {
      _tag: 'steering',
      text: 'Use the simpler approach.',
    }
    expect(part._tag).toBe('steering')
  })
})

describe('Message', () => {
  it('creates a message with multiple content parts', () => {
    const msg: Message = {
      id: 'msg-1',
      sessionId: 'sess-1',
      role: 'assistant',
      content: [
        { _tag: 'thinking', text: 'I should read the file first.' },
        { _tag: 'text', text: 'Let me check that file.' },
      ],
      tokenCount: 42,
      createdAt: Date.now(),
    }
    expect(msg.role).toBe('assistant')
    expect(msg.content).toHaveLength(2)
  })
})

describe('SessionMetadata', () => {
  it('creates empty metadata', () => {
    const meta: SessionMetadata = {}
    expect(meta.mainThreadId).toBeUndefined()
  })

  it('creates metadata with all fields', () => {
    const meta: SessionMetadata = {
      mainThreadId: 'sess-main',
      squashCount: 3,
      fileSnapshots: ['snap-1', 'snap-2'],
    }
    expect(meta.squashCount).toBe(3)
  })
})

describe('Session', () => {
  it('creates a root session', () => {
    const session: Session = {
      id: 'sess-1',
      title: 'New Session',
      parentId: null,
      branchPoint: null,
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(session.parentId).toBeNull()
  })

  it('creates a branched session', () => {
    const session: Session = {
      id: 'sess-2',
      title: 'Fork at message 5',
      parentId: 'sess-1',
      branchPoint: 5,
      metadata: { mainThreadId: 'sess-1' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(session.parentId).toBe('sess-1')
    expect(session.branchPoint).toBe(5)
  })
})
