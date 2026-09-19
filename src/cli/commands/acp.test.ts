import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB, migrateDB } from '../../db/index.js'
import type { ChatOptions, ProviderContext } from '../../llm/index.js'
import type { Config } from '../../shared/types/config.js'
import type { ChatRequest, StreamChunk } from '../../shared/types/llm.js'
import { buildAgentDeps } from '../deps.js'
import type { ACPHandler } from '../modes/acp.js'
import { createAcpHandlers } from './acp.js'

let db: DB
beforeEach(async () => {
  db = await createDB({ driver: 'pglite' })
  await migrateDB(db)
})
afterEach(async () => {
  await db.close()
})

const config: Config = {
  providers: [{ name: 'demo', protocol: 'openai', apiKey: 'k', baseURL: 'https://demo/v1' }],
  defaultProvider: 'demo',
  defaultModel: 'demo-model',
  roleRouting: {},
  fallback: { enabled: false, maxRetries: 0, retryDelay: 0 },
  compaction: { enabled: false, threshold: 0.8, reserveTokens: 8000, keepRecentTokens: 4000 },
  tools: { enabled: ['*'], disabled: [] },
  plugins: { enabled: [] },
  mcpServers: [],
  slashCommands: { enabled: ['*'] },
  theme: 'system',
  toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
  security: { authEnabled: false, allowedOrigins: [] },
  websearch: { provider: 'auto' },
  agents: { subagentConcurrency: 3 },
  permission: { defaultMode: 'default' },
  usage: { monthlyBudgetUsd: 0 },
  update: { enabled: false, intervalMs: 3_600_000, initialDelayMs: 10_000 },
}

// chatStream 产出 StreamChunk；'text' 经 loop 转为 AgentEvent 'text_delta'
async function* mockStream(
  _ctx: ProviderContext,
  _req: ChatRequest,
  _opts: ChatOptions,
): AsyncGenerator<StreamChunk> {
  yield { _tag: 'text', text: 'reply' }
  yield { _tag: 'done' }
}

/** 调用 handler 并保证已注册（noUncheckedIndexedAccess + noNonNullAssertion 友好）。 */
async function invoke(
  handlers: Record<string, ACPHandler>,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fn = handlers[method]
  if (!fn) throw new Error(`handler "${method}" not registered`)
  return fn(params)
}

describe('createAcpHandlers', () => {
  it('session/create returns a sessionId', async () => {
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream: mockStream })
    const handlers = createAcpHandlers(config, deps, { onEvent: () => {} })
    const res = await invoke(handlers, 'session/create', { title: 't' })
    expect(typeof res.sessionId).toBe('string')
  })

  it('chat streams events and returns final text', async () => {
    const events: { method: string; params: Record<string, unknown> }[] = []
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream: mockStream })
    const handlers = createAcpHandlers(config, deps, {
      onEvent: (method, params) => events.push({ method, params }),
    })
    const res = await invoke(handlers, 'chat', { message: 'hi' })
    expect(res.text).toBe('reply')
    expect(events.some((e) => e.method === 'event')).toBe(true)
  })

  it('P2-4：abort 真中止在途 chat（此前空操作，返回 ok 但 agent 继续烧 token）', async () => {
    // chatStream 产出一段文本后阻塞，直到 state.abortController 被中止——
    // 模拟长时间 LLM 流，验证 abort 桥接信号后真正停下。
    const blockingStream = async function* (
      ctx: ProviderContext,
      _req: ChatRequest,
      _opts: ChatOptions,
    ): AsyncGenerator<StreamChunk> {
      yield { _tag: 'text', text: 'partial' }
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) {
          resolve()
          return
        }
        ctx.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    const events: { method: string; params: Record<string, unknown> }[] = []
    const deps = await buildAgentDeps(config, {
      db,
      cwd: process.cwd(),
      chatStream: blockingStream,
    })
    const handlers = createAcpHandlers(config, deps, {
      onEvent: (method, params) => events.push({ method, params }),
    })
    const chatPromise = invoke(handlers, 'chat', { message: 'long task' })
    // 等待首段文本产出，确认 run 已启动
    await vi.waitFor(() => {
      expect(events.some((e) => e.method === 'event')).toBe(true)
    })
    const res = await invoke(handlers, 'abort', {})
    expect(res.ok).toBe(true)
    // 中止后 chat 如实报错（而非静默完成），不再谎报成功
    await expect(chatPromise).rejects.toThrow('已中止')
  })

  it('session/list returns array', async () => {
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream: mockStream })
    const handlers = createAcpHandlers(config, deps, { onEvent: () => {} })
    await invoke(handlers, 'session/create', { title: 'a' })
    const res = await invoke(handlers, 'session/list', {})
    expect(Array.isArray(res.sessions)).toBe(true)
    expect((res.sessions as unknown[]).length).toBe(1)
  })
})
