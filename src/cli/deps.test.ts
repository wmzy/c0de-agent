import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB, migrateDB } from '../db/index.js'
import { resolveRoute } from '../llm/index.js'
import type { Config } from '../shared/types/config.js'
import {
  buildAgentDeps,
  buildRegistryFromConfig,
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

describe('buildRegistryFromConfig', () => {
  it('registers providers from config', () => {
    const reg = buildRegistryFromConfig(config)
    const resolved = resolveRoute(reg, 'demo', 'demo-model')
    expect(resolved.route).toBeTruthy()
  })

  it('handles empty providers', () => {
    const reg = buildRegistryFromConfig({ ...config, providers: [] })
    expect(() => resolveRoute(reg, 'demo', 'x')).toThrow()
  })

  it('跨机不可解密的 enc: apiKey → 跳过 provider 并告警，而非启动崩溃', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const foreign = `enc:${Buffer.from(Array.from({ length: 48 }, (_, i) => i)).toString('base64')}`
      const reg = buildRegistryFromConfig({
        ...config,
        providers: [
          { name: 'demo', protocol: 'openai', apiKey: foreign, baseURL: 'https://demo/v1' },
        ],
      })
      expect(() => resolveRoute(reg, 'demo', 'x')).toThrow()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  // 复现：config.json 手改/旧版/编辑器写入的畸形条目（null 条目、baseURL 非字符串）
  // 在 CLI 侧无守卫——`p.name` 读 null 抛 TypeError、`p.baseURL.replace` 对数字抛
  // TypeError，buildAgentDeps 直接调用本函数且无 try/catch：c0de chat / print / acp
  // 启动即崩溃。server 侧同名实现有「畸形条目跳过」守卫（读取侧自愈兜底），
  // 两处实现漂移——CLI 路径漏网。
  it('畸形条目（null / baseURL 非字符串）跳过而非击穿启动（与 server 侧同口径）', () => {
    expect(() =>
      buildRegistryFromConfig({ ...config, providers: [null] } as unknown as Config),
    ).not.toThrow()
    expect(() =>
      buildRegistryFromConfig({
        ...config,
        providers: [{ name: 'x', protocol: 'openai', apiKey: '', baseURL: 42 }],
      } as unknown as Config),
    ).not.toThrow()
    // 合法条目仍照常注册（跳过畸形不得波及正常 provider）
    const reg = buildRegistryFromConfig(config)
    expect(resolveRoute(reg, 'demo', 'demo-model').route).toBeTruthy()
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

  it('--allow 白名单放行指定 ask 工具，未列出的仍拒绝（含可操作提示）', async () => {
    const deps = await buildAgentDeps(config, {
      db,
      cwd: process.cwd(),
      permissionStrategy: 'safe',
      allowTools: ['write'],
    })
    const allowed = await deps.permission.check(
      { name: 'write', permission: 'ask' } as never,
      {},
      {} as never,
    )
    expect(allowed._tag).toBe('allow')
    const denied = await deps.permission.check(
      { name: 'bash', permission: 'ask' } as never,
      {},
      {} as never,
    )
    expect(denied._tag).toBe('deny')
    if (denied._tag === 'deny') expect(denied.reason).toContain('--allow')
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

  it('injects budgetAbort when usage action is pause（CLI 无恢复 UI，超支中止而非挂起）', async () => {
    const paused = {
      ...config,
      usage: { ...config.usage, budgetAction: 'pause' as const, monthlyBudgetUsd: 10 },
    }
    const deps = await buildAgentDeps(paused, { db, cwd: process.cwd() })
    expect(deps.budgetAbort).toBe(true)
  })

  it('injects budgetAbort when tokenBudgetAction is pause（token 口径同样中止）', async () => {
    const paused = {
      ...config,
      usage: {
        ...config.usage,
        tokenBudgetAction: 'pause' as const,
        monthlyTokenBudget: 1_000_000,
      },
    }
    const deps = await buildAgentDeps(paused, { db, cwd: process.cwd() })
    expect(deps.budgetAbort).toBe(true)
  })

  it('does not inject budgetAbort on default/warn action', async () => {
    const deps = await buildAgentDeps(config, { db, cwd: process.cwd() })
    expect(deps.budgetAbort).toBeUndefined()
  })
})
