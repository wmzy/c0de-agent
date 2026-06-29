import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { createHookRunner } from '../plugins/hooks.js'
import type { HookRunner } from '../plugins/types.js'
import { appendMessage, createSession, getMessages } from '../session/index.js'
import type { AgentEvent, AgentState } from '../shared/types/agent.js'
import type { StreamChunk } from '../shared/types/llm.js'
import type { Message, Session } from '../shared/types/message.js'
import { createDefaultRegistry } from '../tools/index.js'
import { autoAllowChecker } from '../tools/permission.js'
import { DEFAULT_CONFIG } from './config.js'
import type { LoopDeps } from './loop.js'
import { agentLoop } from './loop.js'

function mockTextStream(text: string): AsyncGenerator<StreamChunk> {
  async function* gen() {
    yield { _tag: 'text', text } as const
    yield { _tag: 'done' } as const
  }
  return gen()
}

let mockTurn = 0
function mockToolThenTextStream(): AsyncGenerator<StreamChunk> {
  const turn = mockTurn
  mockTurn++
  async function* gen() {
    if (turn === 0) {
      yield { _tag: 'tool_call_start', id: 'tc1', name: 'read' } as const
      yield {
        _tag: 'tool_call_end',
        id: 'tc1',
        argumentsFinal: JSON.stringify({ path: 'package.json' }),
      } as const
      yield { _tag: 'done' } as const
    } else {
      yield { _tag: 'text', text: 'Done reading.' } as const
      yield { _tag: 'done' } as const
    }
  }
  return gen()
}

// 模型流被截断：工具 arguments 是不完整 JSON → 协议层标记 _parseError 后
// 正常发出 tool_call_end（而非抛错），agent loop 应把错误反馈给模型并继续。
function mockBadJsonToolThenTextStream(): AsyncGenerator<StreamChunk> {
  const turn = mockTurn
  mockTurn++
  async function* gen() {
    if (turn === 0) {
      yield { _tag: 'tool_call_start', id: 'tc1', name: 'grep' } as const
      yield {
        _tag: 'tool_call_end',
        id: 'tc1',
        argumentsFinal: JSON.stringify({
          _parseError: 'Unexpected end of JSON input',
          _raw: '{"pattern": "',
        }),
      } as const
      yield { _tag: 'done' } as const
    } else {
      yield { _tag: 'text', text: 'Recovered.' } as const
      yield { _tag: 'done' } as const
    }
  }
  return gen()
}

function makeMockDeps(db: LoopDeps['db'], streamFn: () => AsyncGenerator<StreamChunk>): LoopDeps {
  return {
    db,
    llmRegistry: {} as LoopDeps['llmRegistry'],
    toolRegistry: createDefaultRegistry(),
    permission: autoAllowChecker,
    config: DEFAULT_CONFIG,
    cwd: process.cwd(),
    chatStream: streamFn as unknown as LoopDeps['chatStream'],
  }
}

function makeMockDepsWithHooks(
  db: LoopDeps['db'],
  streamFn: () => AsyncGenerator<StreamChunk>,
  hookRunner: HookRunner,
): LoopDeps {
  return {
    db,
    llmRegistry: {} as LoopDeps['llmRegistry'],
    toolRegistry: createDefaultRegistry(),
    permission: autoAllowChecker,
    config: DEFAULT_CONFIG,
    cwd: process.cwd(),
    chatStream: streamFn as unknown as LoopDeps['chatStream'],
    hookRunner,
  }
}

function makeState(session: Session, messages: Message[]): AgentState {
  return {
    id: 'agent1',
    session,
    messages,
    tools: [],
    config: {
      provider: 'mock',
      model: 'mock',
      tools: ['read'],
      plugins: [],
      maxTurns: 10,
    },
    status: { _tag: 'idle' },
    abortController: new AbortController(),
    steeringQueue: [],
    llmDetails: [],
    tokenBudget: {
      total: 100_000,
      reserved: 20_000,
      available: 80_000,
      used: 0,
      keepRecent: 10_000,
    },
  }
}

let db: Awaited<ReturnType<typeof createDB>>
let session: Session

beforeEach(async () => {
  mockTurn = 0
  db = await createDB({ driver: 'pglite' })
  await migrateDB(db)
  session = await createSession(db, 'test')
  await appendMessage(db, session.id, {
    role: 'user',
    content: [{ _tag: 'text', text: 'Hello' }],
  })
})
afterEach(async () => {
  await db.close()
})

describe('agentLoop', () => {
  it('emits text_delta and done for a simple text response', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockTextStream('Hello back!'))
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'text_delta' && e.text === 'Hello back!')).toBe(true)
    expect(events.some((e) => e._tag === 'done')).toBe(true)
    // 每轮 LLM 调用后应通知调用详情已持久化
    expect(events.some((e) => e._tag === 'llm_detail')).toBe(true)
  })

  it('emits tool_call events and executes the tool', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockToolThenTextStream())
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'tool_call_start')).toBe(true)
    expect(events.some((e) => e._tag === 'tool_call_end')).toBe(true)
    expect(events.some((e) => e._tag === 'text_delta')).toBe(true)
    expect(events.some((e) => e._tag === 'done')).toBe(true)

    // 回归：持久化的 tool_result 的 id 必须等于对应 tool_call 的 id，
    // 否则发给 provider 的 tool_call_id 与 assistant.tool_calls[].id 不匹配，
    // 触发 "invalid tool_call_id" 错误。
    const stored = await getMessages(db, session.id)
    const toolMsg = stored.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    const resultPart = toolMsg?.content.find((p) => p._tag === 'tool_result')
    expect(resultPart).toBeDefined()
    expect((resultPart as { id: string }).id).toBe('tc1')
  })

  it('工具参数解析失败时反馈错误给模型而非中断会话', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockBadJsonToolThenTextStream())
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    // 不应中断会话（无 error 事件）
    expect(events.some((e) => e._tag === 'error')).toBe(false)
    // 应有 tool_call_end，result 为 error（把解析失败反馈给模型）
    const toolEnd = events.find((e) => e._tag === 'tool_call_end' && e.id === 'tc1')
    expect(toolEnd).toBeDefined()
    expect((toolEnd as { result: { _tag: string } }).result._tag).toBe('error')
    // 会话应恢复并完成
    expect(events.some((e) => e._tag === 'text_delta' && e.text === 'Recovered.')).toBe(true)
    expect(events.some((e) => e._tag === 'done')).toBe(true)
  })

  it('stops on abort', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockTextStream('Hello'))
    state.abortController.abort()
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'error')).toBe(true)
  })

  it('respects maxTurns', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    state.config.maxTurns = 1
    const deps = makeMockDeps(db, () => mockToolThenTextStream())
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'error' && e.error._tag === 'max_turns')).toBe(true)
  })

  it('drains steering messages before LLM call', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    state.steeringQueue.push('Be extra careful')
    const deps = makeMockDeps(db, () => mockTextStream('ok'))
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    expect(state.steeringQueue).toEqual([])
  })

  it('每轮 LLM 调用后记录 LLMDetail 到 state.llmDetails', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    // mockToolThenTextStream：turn0 工具调用，turn1 文本回复 → 两轮 LLM 调用
    const deps = makeMockDeps(db, () => mockToolThenTextStream())
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    expect(state.llmDetails).toHaveLength(2)
    const d0 = state.llmDetails[0]
    const d1 = state.llmDetails[1]
    if (!d0 || !d1) throw new Error('missing llmDetails')
    // 第一轮：工具调用轮次
    expect(d0.model).toBe('mock')
    expect(d0.provider).toBe('mock')
    expect(d0.systemPrompt).toBeTruthy()
    expect(d0.messages.length).toBeGreaterThan(0)
    // state.tools 为空（makeState 未填充），故 LLMDetail.tools 也为空
    expect(d0.tools).toEqual([])
    // responseChunks 应包含原始流块
    expect(d0.responseChunks.some((c) => c._tag === 'tool_call_start')).toBe(true)
    expect(d0.responseChunks.some((c) => c._tag === 'done')).toBe(true)
    expect(d0.latency.total).toBeGreaterThanOrEqual(0)
    // 第二轮：文本回复，responseChunks 含 text
    expect(d1.responseChunks.some((c) => c._tag === 'text')).toBe(true)
  })

  it('LLMDetail 记录 usage 与 thinking（当 stream 提供）', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    async function* streamWithUsage(): AsyncGenerator<StreamChunk> {
      yield { _tag: 'thinking', text: 'let me think' } as const
      yield { _tag: 'text', text: 'answer' } as const
      yield { _tag: 'usage', inputTokens: 10, outputTokens: 5, cacheRead: 2 } as const
      yield { _tag: 'done' } as const
    }
    const deps = makeMockDeps(db, () => streamWithUsage())
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    expect(state.llmDetails).toHaveLength(1)
    const d = state.llmDetails[0]
    if (!d) throw new Error('missing llmDetail')
    expect(d.usage).toEqual({ input: 10, output: 5, cacheRead: 2 })
    expect(d.thinking).toBe('let me think')
  })
})

describe('agentLoop with hookRunner', () => {
  it('fires provider:before hook before LLM call', async () => {
    const hookRunner = createHookRunner()
    const beforeHandler = vi.fn((data) => data)
    hookRunner.on('provider:before', beforeHandler)

    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDepsWithHooks(db, () => mockTextStream('hello'), hookRunner)
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(beforeHandler).toHaveBeenCalledOnce()
    const callArg = beforeHandler.mock.calls[0]?.[0] as { request: { model: string } }
    expect(callArg.request.model).toBe('mock')
  })

  it('aborts when provider:before returns false', async () => {
    const hookRunner = createHookRunner()
    hookRunner.on('provider:before', () => false)

    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDepsWithHooks(db, () => mockTextStream('should-not-appear'), hookRunner)
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    expect(events.some((e) => e._tag === 'error')).toBe(true)
    expect(events.some((e) => e._tag === 'text_delta')).toBe(false)
  })

  it('fires message:before hook with messages array', async () => {
    const hookRunner = createHookRunner()
    const beforeHandler = vi.fn((data) => data)
    hookRunner.on('message:before', beforeHandler)

    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDepsWithHooks(db, () => mockTextStream('ok'), hookRunner)
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    expect(beforeHandler).toHaveBeenCalledOnce()
    const callArg = beforeHandler.mock.calls[0]?.[0] as { messages: unknown[] }
    expect(Array.isArray(callArg.messages)).toBe(true)
    expect(callArg.messages.length).toBeGreaterThan(0)
  })

  it('fires provider:after hook after stream completes', async () => {
    const hookRunner = createHookRunner()
    const afterHandler = vi.fn()
    hookRunner.on('provider:after', afterHandler)

    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDepsWithHooks(db, () => mockTextStream('response'), hookRunner)
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    expect(afterHandler).toHaveBeenCalledOnce()
    const callArg = afterHandler.mock.calls[0]?.[0] as { chunks: StreamChunk[] }
    expect(callArg.chunks.length).toBeGreaterThan(0)
    expect(callArg.chunks.some((c: StreamChunk) => c._tag === 'text')).toBe(true)
  })

  it('passes hookRunner to executeToolCalls (tool:before fires)', async () => {
    const hookRunner = createHookRunner()
    const toolBeforeHandler = vi.fn((data) => data)
    hookRunner.on('tool:before', toolBeforeHandler)

    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDepsWithHooks(db, () => mockToolThenTextStream(), hookRunner)
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    // mockToolThenTextStream yields a read tool call on turn 0
    expect(toolBeforeHandler).toHaveBeenCalledOnce()
    const callArg = toolBeforeHandler.mock.calls[0]?.[0] as { tool: string }
    expect(callArg.tool).toBe('read')
  })
})
