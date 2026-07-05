import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB, migrateDB } from '../../db/index.js'
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
  update: { enabled: false, intervalMs: 3_600_000, initialDelayMs: 10_000, autoApply: false },
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
})
