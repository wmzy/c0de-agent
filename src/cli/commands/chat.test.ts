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
  websearch: { provider: 'auto' },
  agents: { dir: '.c0de/agents', subagentConcurrency: 3 },
  permission: { defaultMode: 'default' },
  update: { enabled: false, intervalMs: 3_600_000, initialDelayMs: 10_000 },
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
      stderr: () => {},
    })
    expect(lines.join('')).toContain('answer')
  })

  it('outputs json when format=json', async () => {
    const lines: string[] = []
    const errs: string[] = []
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream: mockStream })
    await runChatCommand({
      args: { options: { format: 'json' }, positionals: ['hello'] },
      config,
      deps,
      stdout: (s: string) => lines.push(s),
      stderr: (s: string) => errs.push(s),
    })
    const parsed = JSON.parse(lines.join(''))
    expect(parsed.text).toBe('answer')
    // P2-5：一次性问答会话提示走 stderr，不污染 JSON stdout
    expect(errs.join('')).toContain('c0de sessions list')
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

  describe('斜杠命令拦截（与 Web 端同语义）', () => {
    it('/help 本地执行：输出命令列表，不发给 LLM', async () => {
      const lines: string[] = []
      const errs: string[] = []
      const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream: mockStream })
      await runChatCommand({
        args: { options: {}, positionals: ['/help'] },
        config,
        deps,
        stdout: (s: string) => lines.push(s),
        stderr: (s: string) => errs.push(s),
      })
      expect(lines.join('')).toContain('可用命令')
      expect(lines.join('')).toContain('/model')
      // 未走 LLM：chatStream 产物 answer 不应出现
      expect(lines.join('')).not.toContain('answer')
      expect(errs.join('')).toBe('')
    })

    it('/config <key> 本地执行：输出配置值', async () => {
      const lines: string[] = []
      const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream: mockStream })
      await runChatCommand({
        args: { options: {}, positionals: ['/config', 'defaultModel'] },
        config,
        deps,
        stdout: (s: string) => lines.push(s),
      })
      expect(lines.join('')).toContain('demo-model')
    })

    it('/clear 缺 --yes：输出确认指引到 stderr，不发给 LLM', async () => {
      const lines: string[] = []
      const errs: string[] = []
      const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream: mockStream })
      await runChatCommand({
        args: { options: {}, positionals: ['/clear'] },
        config,
        deps,
        stdout: (s: string) => lines.push(s),
        stderr: (s: string) => errs.push(s),
      })
      expect(errs.join('')).toContain('--yes')
      expect(lines.join('')).not.toContain('answer')
    })

    it('未知斜杠命令：回退为普通消息发给 LLM', async () => {
      const lines: string[] = []
      const deps = await buildAgentDeps(config, { db, cwd: process.cwd(), chatStream: mockStream })
      await runChatCommand({
        args: { options: {}, positionals: ['/nope'] },
        config,
        deps,
        stdout: (s: string) => lines.push(s),
      })
      expect(lines.join('')).toContain('answer')
    })
  })
})
