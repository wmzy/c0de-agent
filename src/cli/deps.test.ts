import { resolveRoute } from '../llm/index.js'
import type { DB } from '../db/client.js'
import { createDB, migrateDB } from '../db/index.js'
import type { Config } from '../shared/types/config.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { autoApproveChecker, buildAgentDeps, buildLLMRegistry } from './deps.js'

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
  tools: { enabled: ['read'], disabled: [] },
  plugins: { enabled: [] },
  mcpServers: [],
  slashCommands: { enabled: [] },
  theme: 'system',
  locale: 'en',
}

describe('buildLLMRegistry', () => {
  it('registers providers from config', () => {
    const reg = buildLLMRegistry(config)
    const resolved = resolveRoute(reg, 'demo', 'demo-model')
    expect(resolved.route).toBeTruthy()
  })

  it('handles empty providers', () => {
    const reg = buildLLMRegistry({ ...config, providers: [] })
    expect(() => resolveRoute(reg, 'demo', 'x')).toThrow()
  })
})

describe('autoApproveChecker', () => {
  it('allows any tool', async () => {
    const res = await autoApproveChecker.check(
      { name: 'bash', permission: 'ask' } as never,
      {},
      {} as never,
    )
    expect(res._tag).toBe('allow')
  })
})

describe('buildAgentDeps', () => {
  it('assembles LoopDeps with db, registries, auto permission', async () => {
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd() })
    expect(deps.db).toBe(db)
    expect(deps.config).toBe(config)
    expect(deps.permission).toBe(autoApproveChecker)
    expect(deps.llmRegistry).toBeTruthy()
    expect(deps.toolRegistry).toBeTruthy()
  })
})
