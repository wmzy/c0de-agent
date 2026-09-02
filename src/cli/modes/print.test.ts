import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { DB } from '../../db/client.js'
import { createDB, migrateDB } from '../../db/index.js'
import { sessionEntries, sessions } from '../../db/schema.js'
import type { ChatOptions, ProviderContext } from '../../llm/index.js'
import type { AgentEvent } from '../../shared/types/agent.js'
import type { Config } from '../../shared/types/config.js'
import type { ChatRequest, StreamChunk } from '../../shared/types/llm.js'
import { buildAgentDeps } from '../deps.js'
import { collectAssistantText, runPrintMode } from './print.js'

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
  tools: { enabled: [], disabled: [] },
  plugins: { enabled: [] },
  mcpServers: [],
  slashCommands: { enabled: [] },
  theme: 'system',
  toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
  security: { authEnabled: false, allowedOrigins: [] },
  websearch: { provider: 'auto' },
  agents: { dir: '.c0de/agents', subagentConcurrency: 3 },
  permission: { defaultMode: 'default' },
  update: { enabled: false, intervalMs: 3_600_000, initialDelayMs: 10_000 },
  locale: 'en',
}

/** mock chatStream：产出给定 StreamChunk 序列。签名须匹配 typeof chatStream：(ctx, request, options)。 */
function mockChatStream(chunks: StreamChunk[]) {
  return async function* (
    _ctx: ProviderContext,
    _req: ChatRequest,
    _opts: ChatOptions,
  ): AsyncGenerator<StreamChunk> {
    for (const c of chunks) yield c
  }
}

describe('collectAssistantText', () => {
  it('concatenates text_delta events', () => {
    const events: AgentEvent[] = [
      { _tag: 'text_delta', text: 'Hello' },
      { _tag: 'text_delta', text: ' world' },
      { _tag: 'done' },
    ]
    expect(collectAssistantText(events)).toBe('Hello world')
  })

  it('ignores non-text events', () => {
    const events: AgentEvent[] = [{ _tag: 'thinking', text: 'hmm' }, { _tag: 'done' }]
    expect(collectAssistantText(events)).toBe('')
  })
})

describe('runPrintMode', () => {
  it('returns assistant text from agent run', async () => {
    // StreamChunk 'text' 经 loop 转为 AgentEvent 'text_delta'；loop 在无 tool 调用时自动发 'done'
    const chatStream = mockChatStream([{ _tag: 'text', text: 'Hi there' }, { _tag: 'done' }])
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream })
    const out = await runPrintMode(config, 'ping', deps, { onEvent: () => {} })
    expect(out).toBe('Hi there')
  })

  it('--continue 续聊复用既有 sessionId（不新建会话，消息追加到同一会话）', async () => {
    const chatStream = mockChatStream([{ _tag: 'text', text: 'ok' }, { _tag: 'done' }])
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream })

    // 首轮：无 sessionId → 新建会话
    await runPrintMode(config, 'first question', deps, { onEvent: () => {} })
    const created = await db.db.select({ id: sessions.id }).from(sessions)
    expect(created).toHaveLength(1)
    const sessionId = created[0]!.id
    const entriesAfterFirst = await db.db
      .select({ id: sessionEntries.id })
      .from(sessionEntries)
      .where(eq(sessionEntries.sessionId, sessionId))

    // 续聊：--continue 指向既有会话 → 复用（会话数不变，条目增加）
    await runPrintMode(config, 'follow up', deps, { sessionId, onEvent: () => {} })
    const afterContinue = await db.db.select({ id: sessions.id }).from(sessions)
    expect(afterContinue).toHaveLength(1)
    expect(afterContinue[0]!.id).toBe(sessionId)
    const entriesAfterSecond = await db.db
      .select({ id: sessionEntries.id })
      .from(sessionEntries)
      .where(eq(sessionEntries.sessionId, sessionId))
    expect(entriesAfterSecond.length).toBeGreaterThan(entriesAfterFirst.length)
  })

  it('--continue 非 uuid 输入 → 报 session not found，不泄漏原始 SQL 错误', async () => {
    const chatStream = mockChatStream([])
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream })
    // sessions.id 为 uuid 列：未前置校验时 PG 会抛 "invalid input syntax for type uuid" 原文
    await expect(runPrintMode(config, 'hi', deps, { sessionId: 'not-a-uuid' })).rejects.toThrow(
      'session not found: not-a-uuid',
    )
  })

  it('--continue 合法 uuid 但会话不存在 → 同样报 session not found（与非法输入同语义）', async () => {
    const chatStream = mockChatStream([])
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream })
    await expect(
      runPrintMode(config, 'hi', deps, { sessionId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow('session not found: 00000000-0000-4000-8000-000000000000')
  })
})
