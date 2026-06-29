import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB, migrateDB } from '../../db/index.js'
import type { ChatOptions, ProviderContext } from '../../llm/index.js'
import type { Config } from '../../shared/types/config.js'
import type { ChatRequest, StreamChunk } from '../../shared/types/llm.js'
import { buildAgentDeps } from '../deps.js'
import { runChatCommand } from './chat.js'

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
  locale: 'en',
}

// chatStream 产出 StreamChunk；'text' 经 loop 转为 AgentEvent 'text_delta'
async function* mockStream(
  _ctx: ProviderContext,
  _req: ChatRequest,
  _opts: ChatOptions,
): AsyncGenerator<StreamChunk> {
  yield { _tag: 'text', text: 'answer' }
  yield { _tag: 'done' }
}

describe('runChatCommand', () => {
  it('prints assistant text to stdout', async () => {
    const lines: string[] = []
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream: mockStream })
    await runChatCommand({
      args: { options: {}, positionals: ['hello'] },
      config,
      deps,
      stdout: (s: string) => lines.push(s),
    })
    expect(lines.join('')).toContain('answer')
  })

  it('outputs json when format=json', async () => {
    const lines: string[] = []
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream: mockStream })
    await runChatCommand({
      args: { options: { format: 'json' }, positionals: ['hello'] },
      config,
      deps,
      stdout: (s: string) => lines.push(s),
    })
    const parsed = JSON.parse(lines.join(''))
    expect(parsed.text).toBe('answer')
  })

  it('errors when no message positional', async () => {
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream: mockStream })
    await expect(
      runChatCommand({
        args: { options: {}, positionals: [] },
        config,
        deps,
        stdout: () => {},
        stderr: () => {},
      }),
    ).rejects.toThrow(/message/i)
  })
})
