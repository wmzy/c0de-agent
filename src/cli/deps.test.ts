import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB, migrateDB } from '../db/index.js'
import { resolveRoute } from '../llm/index.js'
import type { Config } from '../shared/types/config.js'
import {
  buildAgentDeps,
  buildLLMRegistry,
  fullyAutoApproveChecker,
  nonInteractiveSafeChecker,
} from './deps.js'

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
  toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
  security: { authEnabled: false, allowedOrigins: [] },
  websearch: { provider: 'auto' },
  agents: { dir: '.c0de/agents', subagentConcurrency: 3 },
  permission: { defaultMode: 'default' },
  update: { enabled: false, intervalMs: 3_600_000, initialDelayMs: 10_000 },
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

describe('fullyAutoApproveChecker', () => {
  it('allows any tool unconditionally', async () => {
    const res = await fullyAutoApproveChecker.check(
      { name: 'bash', permission: 'ask' } as never,
      {},
      {} as never,
    )
    expect(res._tag).toBe('allow')
  })
})

describe('nonInteractiveSafeChecker', () => {
  it('allow 只读（permission: auto）工具', async () => {
    const res = await nonInteractiveSafeChecker.check(
      { name: 'read', permission: 'auto' } as never,
      {},
      {} as never,
    )
    expect(res._tag).toBe('allow')
  })

  it('deny 写/执行（permission: ask）工具，且提示含可操作指引（-y / serve）', async () => {
    const res = await nonInteractiveSafeChecker.check(
      { name: 'bash', permission: 'ask' } as never,
      {},
      {} as never,
    )
    expect(res._tag).toBe('deny')
    if (res._tag !== 'deny') return
    // 拒绝原因必须给出两条出路：加 -y 放行，或改用 serve 交互确认
    expect(res.reason).toContain('-y')
    expect(res.reason).toContain('serve')
    expect(res.reason).toContain('bash')
  })

  it('deny permission: deny 工具（原样透传 autoAllowChecker 判定）', async () => {
    const res = await nonInteractiveSafeChecker.check(
      { name: 'dangerous', permission: 'deny' } as never,
      {},
      {} as never,
    )
    expect(res._tag).toBe('deny')
  })
})

describe('buildAgentDeps', () => {
  it('defaults to nonInteractiveSafeChecker when config.defaultMode is default', async () => {
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd() })
    expect(deps.db).toBe(db)
    expect(deps.config).toBe(config)
    expect(deps.permission).toBe(nonInteractiveSafeChecker)
    expect(deps.llmRegistry).toBeTruthy()
    expect(deps.toolRegistry).toBeTruthy()
  })

  it('uses fullyAutoApproveChecker when strategy is full-auto', async () => {
    const deps = await buildAgentDeps(config, {
      db,
      cwd: process.cwd(),
      permissionStrategy: 'full-auto',
    })
    expect(deps.permission).toBe(fullyAutoApproveChecker)
  })

  it('uses nonInteractiveSafeChecker when strategy is safe', async () => {
    const deps = await buildAgentDeps(config, {
      db,
      cwd: process.cwd(),
      permissionStrategy: 'safe',
    })
    expect(deps.permission).toBe(nonInteractiveSafeChecker)
  })

  it('falls back to config.permission.defaultMode when strategy omitted', async () => {
    const yolo = { ...config, permission: { defaultMode: 'auto' as const } }
    const deps = await buildAgentDeps(yolo, { db, cwd: process.cwd() })
    expect(deps.permission).toBe(fullyAutoApproveChecker)
  })

  it('wires a default URL registry resolving file:// and skill://', async () => {
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd() })
    expect(deps.urlRegistry?.resolvers.has('file')).toBe(true)
    expect(deps.urlRegistry?.resolvers.has('skill')).toBe(true)
  })
})
