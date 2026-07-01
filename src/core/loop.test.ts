import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { createHookRunner } from '../plugins/hooks.js'
import type { HookRunner } from '../plugins/types.js'
import { appendMessage, createSession, getMessages } from '../session/index.js'
import { getLLMSegments } from '../session/session.js'
import type { AgentEvent, AgentState } from '../shared/types/agent.js'
import type { StreamChunk } from '../shared/types/llm.js'
import type { Message, Session } from '../shared/types/message.js'
import { editTool } from '../tools/builtin/edit.js'
import { createDefaultRegistry, createToolRegistry } from '../tools/index.js'
import { listTools } from '../tools/registry.js'
import { autoAllowChecker } from '../tools/permission.js'
import { BUILTIN_AGENTS, createAgentRegistry } from './agents/index.js'
import { DEFAULT_CONFIG } from './config.js'
import type { LoopDeps } from './loop.js'
import { agentLoop, runSubAgent } from './loop.js'
import { getToolMetrics, recordToolMetrics } from './metrics.js'

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
// 正常发出 tool_call_end（而非抛错），agent loop 应透明跳过该调用并继续，
// 让模型下轮重新生成（而非持久化注定被 sanitize 丢弃的 orphan tool 消息）。
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

// 模型响应被 max_tokens 截断：finish_reason=length，本轮无 tool_call。
// agent loop 不应当成正常 completed，否则被截断的半截回答会静默成功。
function mockLengthTruncatedStream(): AsyncGenerator<StreamChunk> {
  async function* gen() {
    yield { _tag: 'text', text: '这是一段被截断的回答' } as const
    yield { _tag: 'done', finishReason: 'length' } as const
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
    agentRegistry: makeAgentRegistry(),
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
    agentRegistry: makeAgentRegistry(),
  }
}

/** 构建含内置 agent 的注册表（runSubAgent 按 agentType 派发需要）。 */
function makeAgentRegistry() {
  const reg = createAgentRegistry()
  for (const def of BUILTIN_AGENTS) reg.register(def)
  return reg
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
    segments: [],
    tokenBudget: {
      total: 100_000,
      reserved: 20_000,
      available: 80_000,
      historyBudget: 60_000,
      used: 0,
      keepRecent: 10_000,
    },
    calibrationFactor: 1.0,
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

  it('agentRolePrompt 覆盖 role section 但保留工具段', async () => {
    const messages = await getMessages(db, session.id)
    let capturedSystem = ''
    // 工厂捕获 loop 传入的 request.system（loop 调 streamFn(depsObj, request, info)）
    const captureStream = ((_d: unknown, request: { system?: string }) => {
      capturedSystem = request.system ?? ''
      async function* gen(): AsyncGenerator<StreamChunk> {
        yield { _tag: 'text', text: 'planned' }
        yield { _tag: 'done' }
      }
      return gen()
    }) as unknown as () => AsyncGenerator<StreamChunk>
    const deps = makeMockDeps(db, captureStream)
    const state = makeState(session, messages)
    // 设置 primary agent role prompt
    state.config.agentRolePrompt = 'OVERRIDE_PLAN_ROLE'
    state.config.tools = ['read']
    state.tools = listTools(deps.toolRegistry, { config: {}, cwd: deps.cwd }).filter((t) =>
      state.config.tools.includes(t.name),
    )

    for await (const _event of agentLoop(state, deps)) {
      // 消费完
    }

    expect(capturedSystem).toContain('OVERRIDE_PLAN_ROLE')
    // 工具段仍保留（未被整段替换抹掉）
    expect(capturedSystem).toContain('## Available Tools')
    expect(capturedSystem).toContain('**read**')
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

    // 回归：tool_call_start 必须携带解析后的真实入参，而非流式半成品的空 {}。
    // 旧实现在 tool-input-start 时就发 input:{}，导致前端渲染 "Read · " 等空标题卡
    // 且永不更新；解析完成后的真实入参再也没机会纠正该 part。
    const start = events.find(
      (e): e is Extract<AgentEvent, { _tag: 'tool_call_start' }> =>
        e._tag === 'tool_call_start' && e.id === 'tc1',
    )
    expect(start?.input).toEqual({ path: 'package.json' })

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

  it('工具参数解析失败时透明跳过而非中断会话', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockBadJsonToolThenTextStream())
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    // 不应中断会话（无 error 事件）
    expect(events.some((e) => e._tag === 'error')).toBe(false)
    // 解析失败的调用对系统完全透明：不发 tool_call_start（前端无半成品卡）、
    // 不发 tool_call_end（无 orphan 事件）。模型下轮重新生成即可修正一次性截断。
    expect(events.some((e) => e._tag === 'tool_call_start' && e.id === 'tc1')).toBe(false)
    expect(events.some((e) => e._tag === 'tool_call_end' && e.id === 'tc1')).toBe(false)
    // 会话应恢复并完成
    expect(events.some((e) => e._tag === 'text_delta' && e.text === 'Recovered.')).toBe(true)
    expect(events.some((e) => e._tag === 'done')).toBe(true)

    // 回归：解析失败的调用不应把 _raw/_parseError 容错标记泄漏到持久化消息。
    // 旧实现会把 { _parseError, _raw } 原样写进 assistant tool_call 入参并落库，
    // 刷新后被 FallbackToolView 平铺成 "_raw: }" / "_parseError: [object Object]"。
    const stored = await getMessages(db, session.id)
    const leaked = stored
      .flatMap((m) => m.content)
      .filter(
        (p): p is Extract<typeof p, { input: unknown }> =>
          typeof p === 'object' && p !== null && 'input' in p,
      )
      .some(
        (p) =>
          p.input !== null &&
          typeof p.input === 'object' &&
          ('_parseError' in (p.input as object) || '_raw' in (p.input as object)),
      )
    expect(leaked).toBe(false)
    // 回归：不应持久化无对应 assistant tool_call 的 orphan tool 消息——它会被
    // context.ts 的 sanitizeToolPairs 在重建上下文时丢弃，属注定无效的冗余 DB 写。
    const orphanTool = stored.find(
      (m) => m.role === 'tool' && m.content.some((p) => p._tag === 'tool_result' && p.id === 'tc1'),
    )
    expect(orphanTool).toBeUndefined()
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

  it('被 max_tokens 截断时报错而非静默当作完成', async () => {
    // finish_reason=length 且无 tool_call：以前 loop 会判定 completed 并静默退出，
    // 导致半截回答看起来“成功”。现在应报 error，让截断可见。
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockLengthTruncatedStream())
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }
    // 不应静默完成
    expect(events.some((e) => e._tag === 'done')).toBe(false)
    // 应报错
    expect(events.some((e) => e._tag === 'error')).toBe(true)
    expect(state.status._tag).toBe('stopped')
    if (state.status._tag === 'stopped') {
      expect(state.status.reason).toBe('error')
    }
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

  it('同前缀多轮调用归入同一 segment，calls 增量追加', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    // mockToolThenTextStream：turn0 工具调用，turn1 文本回复 → 两轮 LLM 调用
    const deps = makeMockDeps(db, () => mockToolThenTextStream())
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    // 两轮调用、前缀不变 → 单段两 call
    expect(state.segments).toHaveLength(1)
    const seg = state.segments[0]
    if (!seg) throw new Error('missing segment')
    expect(seg.trigger).toBe('initial')
    expect(seg.calls).toHaveLength(2)
    expect(seg.systemPrompt).toBeTruthy()
    expect(seg.tools).toEqual([])
    // 段内 call 不含 messages/systemPrompt（轻量）
    const c0 = seg.calls[0]
    if (!c0) throw new Error('missing call 0')
    // turn0 为工具调用轮：无文本回复，responseText 为空
    expect(c0.responseText).toBe('')
    expect(c0.latency.total).toBeGreaterThanOrEqual(0)
    const c1 = seg.calls[1]
    if (!c1) throw new Error('missing call 1')
    // turn1 为文本回复轮
    expect(c1.responseText.length).toBeGreaterThan(0)
  })

  it('call 记录 usage 与 thinking（当 stream 提供）', async () => {
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
    expect(state.segments).toHaveLength(1)
    const seg = state.segments[0]
    const call = seg?.calls[0]
    if (!call) throw new Error('missing call')
    expect(call.usage).toEqual({ input: 10, output: 5, cacheRead: 2 })
    expect(call.thinking).toBe('let me think')
    expect(call.responseText).toBe('answer')
  })

  it('中途 model 变化 → 开新段 trigger=model_change', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockTextStream('hi'))
    // 先跑一轮建立首段
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    expect(state.segments).toHaveLength(1)
    // 切换模型后再跑一轮（agentLoop 可重复进入：重置 status 并从 DB 重读消息）
    state.config.model = 'other-model'
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    expect(state.segments).toHaveLength(2)
    const seg2 = state.segments[1]
    if (!seg2) throw new Error('missing segment 2')
    expect(seg2.trigger).toBe('model_change')
    expect(seg2.model).toBe('other-model')
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

describe('agentLoop task delegation (spec §12.3)', () => {
  // chatStream 调用序列：父派发 task → 子 agent 输出 → 父总结。
  function mockTaskDelegationStream(): () => AsyncGenerator<StreamChunk> {
    let call = 0
    return () => {
      const n = call++
      async function* gen() {
        if (n === 0) {
          // 父轮 0：派发 task 工具调用
          yield { _tag: 'tool_call_start', id: 'tc1', name: 'task' } as const
          yield {
            _tag: 'tool_call_end',
            id: 'tc1',
            argumentsFinal: JSON.stringify({
              prompt: 'write unit tests for the parser',
              description: 'Test writer',
            }),
          } as const
          yield { _tag: 'done' } as const
        } else if (n === 1) {
          // 子 agent 轮：输出文本后结束
          yield { _tag: 'text', text: 'tests written' } as const
          yield { _tag: 'done' } as const
        } else {
          // 父轮 1：总结
          yield { _tag: 'text', text: 'Delegated.' } as const
          yield { _tag: 'done' } as const
        }
      }
      return gen()
    }
  }

  it('runs a sub-agent via the task tool and returns its output', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    state.config = { ...state.config, tools: ['task'] }
    const deps = makeMockDeps(db, mockTaskDelegationStream())
    const events: AgentEvent[] = []
    for await (const ev of agentLoop(state, deps)) {
      events.push(ev)
    }

    // 父派发了 task 工具调用
    const start = events.find((e) => e._tag === 'tool_call_start' && e.tool === 'task')
    expect(start).toBeTruthy()

    // task 返回子 agent 的输出与 sessionId
    const end = events.find((e) => e._tag === 'tool_call_end')
    expect(end).toBeTruthy()
    if (end && end._tag === 'tool_call_end') {
      expect(end.result._tag).toBe('success')
      if (end.result._tag === 'success') {
        expect(end.result.output).toContain('tests written')
        expect(end.result.metadata?.sessionId).toBeTruthy()
      }
    }

    // 父最终正常完成
    expect(events.some((e) => e._tag === 'done')).toBe(true)
  })

  it('creates an isolated child session in the DB', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    state.config = { ...state.config, tools: ['task'] }
    const deps = makeMockDeps(db, mockTaskDelegationStream())
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    // 子会话标题取自 description
    const { listSessions } = await import('../session/index.js')
    const all = await listSessions(db)
    const child = all.find((s) => s.title === 'Test writer')
    expect(child).toBeTruthy()
    expect(child?.id).not.toBe(session.id)
  })
})

describe('runSubAgent background', () => {
  it('background 模式立即返回 running，不阻塞', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockTextStream('child output'))
    const result = await runSubAgent(deps, state, {
      agentType: 'general',
      prompt: 'p',
      background: true,
    })
    expect(result._tag).toBe('running')
    if (result._tag === 'running') {
      expect(result.sessionId).toBeTruthy()
      expect(result.jobId).toBe(result.sessionId)
    }
  })

  it('未知 agentType 返回 error', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockTextStream('x'))
    const result = await runSubAgent(deps, state, { agentType: 'nonexistent', prompt: 'p' })
    expect(result._tag).toBe('error')
    if (result._tag === 'error') expect(result.error).toMatch(/Unknown agent type/i)
  })
})

describe('agentLoop tool-mode metrics (spec §16.5)', () => {
  it('工具执行后记录 metrics 到 DB', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockToolThenTextStream())
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    // read 工具执行成功 → 记录 read/default/success
    const ms = await getToolMetrics(db, 'mock', 'read')
    expect(ms).toHaveLength(1)
    expect(ms[0]).toMatchObject({
      model: 'mock',
      tool: 'read',
      mode: 'default',
      attempts: 1,
      successes: 1,
      failures: 0,
    })
  })

  it('失败的工具调用记录为 failure', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    // mockToolThenTextStream 调 read 一个不存在的路径 → error
    const deps = makeMockDeps(db, () => mockToolThenTextStream())
    // 用空 toolRegistry：read 工具不存在 → 返回 error
    deps.toolRegistry = createToolRegistry()
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    const ms = await getToolMetrics(db, 'mock', 'read')
    expect(ms).toHaveLength(1)
    expect(ms[0]).toMatchObject({ attempts: 1, successes: 0, failures: 1 })
  })

  it('edit 历史成功率高时注入 hashline 偏好到 system prompt', async () => {
    // 预置 metrics：hashline 9/10 成功，diff 4/10 成功
    for (let i = 0; i < 9; i++) await recordToolMetrics(db, 'mock', 'edit', 'hashline', true, 100)
    await recordToolMetrics(db, 'mock', 'edit', 'hashline', false, 100)
    for (let i = 0; i < 6; i++) await recordToolMetrics(db, 'mock', 'edit', 'diff', false, 100)
    for (let i = 0; i < 4; i++) await recordToolMetrics(db, 'mock', 'edit', 'diff', true, 100)

    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    state.tools = [editTool]
    const deps = makeMockDeps(db, () => mockTextStream('ok'))
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    const details = await getLLMSegments(db, session.id)
    expect(details[0]?.systemPrompt).toContain('hashline')
  })

  it('数据不足时不注入偏好（用默认 diff）', async () => {
    // 仅 2 次 hashline 成功（< minSamples 5）→ 不达标，不注入
    await recordToolMetrics(db, 'mock', 'edit', 'hashline', true, 100)
    await recordToolMetrics(db, 'mock', 'edit', 'hashline', true, 100)

    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    state.tools = [editTool]
    const deps = makeMockDeps(db, () => mockTextStream('ok'))
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    const details = await getLLMSegments(db, session.id)
    expect(details[0]?.systemPrompt).not.toContain('Tool-mode preference')
  })
})
