import { describe, expect, it } from 'vitest'
import type { MemoryLlmCall, MemoryLlmConfig, MemoryToolCallResult } from '../memory/llm-call.js'
import type { Config } from '../shared/types/config.js'
import type { Message, MessageContent } from '../shared/types/message.js'
import { createAdvisorRuntime } from './runtime.js'
import type { AdvisorNote } from './types.js'

/** fire-and-forget 链冲刷：onTurnEnd 同步返回，微任务链在两个 macrotask
 *  之内必然 settle（串行链无真实定时器）。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let seq = 0
function msg(text: string): Message {
  seq += 1
  const content: MessageContent[] = [{ _tag: 'text', text }]
  return { id: `m${seq}`, sessionId: 's1', role: 'user', content, tokenCount: 10, createdAt: seq }
}

function advisorConfig(advisor: Partial<NonNullable<Config['advisor']>> = {}): Config {
  return {
    providers: [{ name: 'test', protocol: 'openai', apiKey: 'k', baseURL: 'http://localhost:1' }],
    defaultProvider: 'test',
    defaultModel: 'main-model',
    roleRouting: {},
    fallback: { enabled: false, maxRetries: 0, retryDelay: 0 },
    compaction: { enabled: false, threshold: 0.8, reserveTokens: 8000, keepRecentTokens: 4000 },
    tools: { enabled: ['*'], disabled: [] },
    plugins: { enabled: [] },
    mcpServers: [],
    slashCommands: { enabled: ['*'] },
    contextFiles: { enabled: true, extra: [] },
    magicKeywords: { enabled: true, ultrathink: true, orchestrate: true, workflow: true },
    lsp: { servers: {} },
    advisor: { enabled: true, maxNotesPerUpdate: 4, immuneTurns: 3, ...advisor },
    toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
    security: { authEnabled: false, allowedOrigins: [] },
    websearch: { provider: 'auto' },
    agents: { subagentConcurrency: 3 },
    permission: { defaultMode: 'default' },
    usage: { monthlyBudgetUsd: 0 },
    update: { enabled: false, intervalMs: 3_600_000, initialDelayMs: 10_000 },
    theme: 'system',
  }
}

interface CapturedCall {
  input: string
  config: MemoryLlmConfig
  model: { provider: string; model: string } | undefined
}

const EMPTY_RESULT: MemoryToolCallResult = { toolCalls: [], finishReason: 'stop' }

/** 结果队列 fake：每次调用弹出一条返回值（耗尽后复用末条）；记录收到的 input/config。 */
function llmQueue(results: (MemoryToolCallResult | Error)[]) {
  const calls: CapturedCall[] = []
  let index = 0
  const llmCall: MemoryLlmCall = async (opts) => {
    calls.push({ input: opts.input, config: opts.config, model: opts.model })
    const result =
      index < results.length ? (results[index] as MemoryToolCallResult | Error) : undefined
    index += 1
    if (result instanceof Error) throw result
    if (result) return result
    // 队列耗尽且末条是 Error：静默空结果（审查失败路径已被覆盖测试）。
    for (let i = results.length - 1; i >= 0; i--) {
      const r: MemoryToolCallResult | Error = results[i] as MemoryToolCallResult | Error
      if (!(r instanceof Error)) return r
    }
    return EMPTY_RESULT
  }
  return { llmCall, calls }
}

function adviseResult(notes: { note: string; severity?: string }[]): MemoryToolCallResult {
  return {
    toolCalls: notes.map((n) => ({
      name: 'advise',
      arguments:
        n.severity === undefined ? { note: n.note } : { note: n.note, severity: n.severity },
    })),
    finishReason: 'tool-calls',
  }
}

describe('createAdvisorRuntime', () => {
  it('enabled=false 时整体 no-op（不打 LLM）', async () => {
    const { llmCall, calls } = llmQueue([adviseResult([{ note: 'something' }])])
    const runtime = createAdvisorRuntime(advisorConfig({ enabled: false }), {
      onNote: () => {
        throw new Error('must not fire')
      },
      llmCall,
    })
    runtime.onTurnEnd({
      sessionId: 's1',
      cwd: '/tmp',
      messages: [msg('hello')],
      willContinue: false,
    })
    await settle()
    expect(calls.length).toBe(0)
  })

  it('LLM 准入 note 经 onNote 注入；severity 缺省/非法回退 nit', async () => {
    const notes: AdvisorNote[] = []
    const { llmCall, calls } = llmQueue([
      adviseResult([
        { note: 'concrete concern about error handling' },
        { note: 'invalid severity falls back', severity: 'urgent' },
        { note: 'Looks good.' }, // 噪声：不注入
        { note: 'real blocker here', severity: 'blocker' },
      ]),
    ])
    const runtime = createAdvisorRuntime(advisorConfig(), { onNote: (n) => notes.push(n), llmCall })
    runtime.onTurnEnd({
      sessionId: 's1',
      cwd: '/repo',
      messages: [msg('please fix the bug')],
      willContinue: false,
    })
    await settle()
    expect(notes).toEqual([
      { note: 'concrete concern about error handling', severity: 'nit' },
      { note: 'invalid severity falls back', severity: 'nit' },
      { note: 'real blocker here', severity: 'blocker' },
    ])
    // 输入文本：增量块 + 工作目录 + turn 结束状态
    expect(calls[0]?.input).toContain('please fix the bug')
    expect(calls[0]?.input).toContain('Working directory: /repo')
    expect(calls[0]?.input).toContain('The turn has ended')
    expect(notes).toEqual(runtime.getNotes())
  })

  it('willContinue=true 提示部分工作只报 blocker', async () => {
    const { llmCall, calls } = llmQueue([adviseResult([])])
    const runtime = createAdvisorRuntime(advisorConfig(), { onNote: () => {}, llmCall })
    runtime.onTurnEnd({ sessionId: 's1', cwd: '/r', messages: [msg('step 1')], willContinue: true })
    await settle()
    expect(calls[0]?.input).toContain('mid-run')
  })

  it('无新增消息跳过本趟（不叠无意义请求）', async () => {
    const { llmCall, calls } = llmQueue([adviseResult([{ note: 'x' }])])
    const runtime = createAdvisorRuntime(advisorConfig(), { onNote: () => {}, llmCall })
    const messages = [msg('once')]
    runtime.onTurnEnd({ sessionId: 's1', cwd: '/r', messages, willContinue: false })
    await settle()
    expect(calls.length).toBe(1)
    runtime.onTurnEnd({ sessionId: 's1', cwd: '/r', messages, willContinue: true })
    await settle()
    expect(calls.length).toBe(1)
  })

  it('LLM 调用失败被吞掉（不抛出、不断链）', async () => {
    const notes: AdvisorNote[] = []
    const { llmCall } = llmQueue([
      new Error('provider down'),
      adviseResult([{ note: 'later note' }]),
    ])
    const runtime = createAdvisorRuntime(advisorConfig(), { onNote: (n) => notes.push(n), llmCall })
    runtime.onTurnEnd({ sessionId: 's1', cwd: '/r', messages: [msg('first')], willContinue: false })
    await settle()
    expect(notes).toEqual([])
    // 首趟失败不拖垮后续审查
    runtime.onTurnEnd({
      sessionId: 's1',
      cwd: '/r',
      messages: [msg('first'), msg('second')],
      willContinue: false,
    })
    await settle()
    expect(notes).toEqual([{ note: 'later note', severity: 'nit' }])
  })

  it('在途审查串行：第二趟等第一趟完成才开始', async () => {
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    const llmCall: MemoryLlmCall = async () => {
      if (order.length === 0) {
        order.push('first-start')
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        order.push('first-end')
        return adviseResult([])
      }
      order.push('second-start')
      return adviseResult([])
    }
    const runtime = createAdvisorRuntime(advisorConfig(), { onNote: () => {}, llmCall })
    runtime.onTurnEnd({ sessionId: 's1', cwd: '/r', messages: [msg('a')], willContinue: false })
    await settle()
    runtime.onTurnEnd({
      sessionId: 's1',
      cwd: '/r',
      messages: [msg('a'), msg('b')],
      willContinue: false,
    })
    await settle()
    expect(order).toEqual(['first-start']) // 第二趟仍在等第一趟
    releaseFirst?.()
    await settle()
    await settle()
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })

  it('immuneTurns：blocker 打断后的 update 内非 blocker 被冷却', async () => {
    const notes: AdvisorNote[] = []
    const { llmCall } = llmQueue([
      adviseResult([{ note: 'hard blocker', severity: 'blocker' }]),
      adviseResult([{ note: 'post-blocker nit' }]),
      adviseResult([{ note: 'window over nit' }]),
    ])
    const runtime = createAdvisorRuntime(advisorConfig({ immuneTurns: 1 }), {
      onNote: (n) => notes.push(n),
      llmCall,
    })
    runtime.onTurnEnd({ sessionId: 's1', cwd: '/r', messages: [msg('t1')], willContinue: false })
    await settle()
    runtime.onTurnEnd({
      sessionId: 's1',
      cwd: '/r',
      messages: [msg('t1'), msg('t2')],
      willContinue: false,
    })
    await settle()
    expect(notes).toEqual([{ note: 'hard blocker', severity: 'blocker' }]) // nit 被冷却
    runtime.onTurnEnd({
      sessionId: 's1',
      cwd: '/r',
      messages: [msg('t1'), msg('t2'), msg('t3')],
      willContinue: false,
    })
    await settle()
    expect(notes).toEqual([
      { note: 'hard blocker', severity: 'blocker' },
      { note: 'window over nit', severity: 'nit' },
    ])
  })

  it('advisor.model 覆盖进入 LLM 调用的 model 参数；未设置回退默认模型', async () => {
    const { llmCall, calls } = llmQueue([adviseResult([])])
    const runtime = createAdvisorRuntime(
      advisorConfig({ model: { provider: 'reviewer', model: 'strong-model' } }),
      { onNote: () => {}, llmCall },
    )
    runtime.onTurnEnd({ sessionId: 's1', cwd: '/r', messages: [msg('x')], willContinue: false })
    await settle()
    expect(calls[0]?.model).toEqual({ provider: 'reviewer', model: 'strong-model' })
    // config 原样透传：不再伪造 memory.sharpshooter 视图。
    expect(calls[0]?.config.memory).toBeUndefined()

    const { llmCall: llm2, calls: calls2 } = llmQueue([adviseResult([])])
    const runtime2 = createAdvisorRuntime(advisorConfig(), { onNote: () => {}, llmCall: llm2 })
    runtime2.onTurnEnd({ sessionId: 's1', cwd: '/r', messages: [msg('y')], willContinue: false })
    await settle()
    expect(calls2[0]?.model).toEqual({ provider: 'test', model: 'main-model' })
  })

  it('dispose 后不再接受新审查；getNotes 返回副本', async () => {
    const { llmCall, calls } = llmQueue([adviseResult([])])
    const runtime = createAdvisorRuntime(advisorConfig(), { onNote: () => {}, llmCall })
    runtime.dispose()
    runtime.onTurnEnd({
      sessionId: 's1',
      cwd: '/r',
      messages: [msg('after dispose')],
      willContinue: false,
    })
    await settle()
    expect(calls.length).toBe(0)
    const snapshot = runtime.getNotes()
    snapshot.push({ note: 'tampered', severity: 'nit' })
    expect(runtime.getNotes().length).toBe(0)
  })
})
