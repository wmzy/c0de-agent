import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRegistry, type Registry, registerProvider } from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'
import {
  consecutiveFailures,
  consolidationMaxTokens,
  nextConsolidationAt,
  parseReplacementFiles,
  renderSessions,
  runConsolidation,
} from './consolidate.js'
import type { MemoryLlmCall, MemoryToolCallResult } from './llm-call.js'
import { acquireBankLock, appendDelta, listDeltas, readState } from './storage.js'
import {
  SHARPSHOOTER_MEMORY_FILES,
  type SharpshooterDelta,
  type SharpshooterState,
} from './types.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-consolidate-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function fakeRegistry(): Registry {
  const registry = createRegistry()
  registerProvider(registry, { name: 'test', baseURL: 'http://localhost:1', apiKey: 'k' })
  return registry
}

function fakeConfig(memory: Partial<NonNullable<Config['memory']>> = {}): Config {
  return {
    providers: [{ name: 'test', protocol: 'openai', apiKey: 'k', baseURL: 'http://localhost:1' }],
    defaultProvider: 'test',
    defaultModel: 'm1',
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
    theme: 'system',
    toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
    security: { authEnabled: false, allowedOrigins: [] },
    websearch: { provider: 'auto' },
    agents: { subagentConcurrency: 3 },
    permission: { defaultMode: 'default' },
    usage: { monthlyBudgetUsd: 0 },
    update: { enabled: false, intervalMs: 3_600_000, initialDelayMs: 10_000 },
    memory: {
      backend: 'sharpshooter',
      sharpshooter: {
        intervalMinutes: 5,
        minPromptLength: 16,
        injectionTokenLimit: 15000,
        maxFileLines: 3,
      },
      ...memory,
    },
  }
}

function llmReturning(toolCalls: { name: string; arguments: unknown }[]): MemoryLlmCall {
  return async (): Promise<MemoryToolCallResult> => ({ toolCalls, finishReason: 'tool-calls' })
}

function validFilesTool(content: Partial<Record<string, string>> = {}): {
  name: string
  arguments: unknown
} {
  return {
    name: 'replace_memory_files',
    arguments: {
      files: SHARPSHOOTER_MEMORY_FILES.map((name) => ({ name, content: content[name] ?? '' })),
    },
  }
}

function delta(overrides: Partial<SharpshooterDelta> = {}): SharpshooterDelta {
  return {
    v: 1,
    kind: 'constraint',
    statement: 'Follow biome formatting in all files',
    source: 'explicit_user',
    evidence: 'follow biome',
    friction: { corrective: true, regression: false, subtle: false },
    sessionId: 'sess-1',
    ts: 1_000,
    ...overrides,
  }
}

describe('nextConsolidationAt（到期与退避）', () => {
  const MIN = 60_000

  it('无失败：上次成功 + interval', () => {
    const state: SharpshooterState = { v: 1, lastConsolidatedAt: 1_000_000 }
    expect(nextConsolidationAt(state, 5)).toBe(1_000_000 + 5 * MIN)
  })

  it('连续失败按 interval×2^(n-1) 退避，clamp [1min, 6h]', () => {
    const at = 2_000_000
    const state: SharpshooterState = {
      v: 1,
      lastConsolidatedAt: 1_000_000,
      lastError: { at, message: 'x', failures: 1 },
    }
    // 1 次失败：interval 5min ≥ 1min → 退避 5min。
    expect(nextConsolidationAt(state, 5)).toBe(at + 5 * MIN)
    // 3 次失败：5min×4 = 20min。
    const state3 = { ...state, lastError: { at, message: 'x', failures: 3 } }
    expect(nextConsolidationAt(state3, 5)).toBe(at + 20 * MIN)
    // 退避下限 1min（interval=0 时仍至少等 1 分钟）。
    const stateZero = { ...state, lastError: { at, message: 'x', failures: 1 } }
    expect(nextConsolidationAt(stateZero, 0)).toBe(at + MIN)
    // 上限 6h（interval 60min × 2^7 远超）。
    const stateBig = { ...state, lastError: { at, message: 'x', failures: 8 } }
    expect(nextConsolidationAt(stateBig, 60)).toBe(at + 6 * 60 * MIN)
  })

  it('早于上次成功的陈旧错误不计数', () => {
    const state: SharpshooterState = {
      v: 1,
      lastConsolidatedAt: 2_000_000,
      lastError: { at: 1_500_000, message: 'old', failures: 4 },
    }
    expect(consecutiveFailures(state)).toBe(0)
    expect(nextConsolidationAt(state, 5)).toBe(2_000_000 + 5 * MIN)
  })
})

describe('consolidationMaxTokens', () => {
  it('min(32k, maxOutput, 上下文剩余)，下限 1024', () => {
    expect(consolidationMaxTokens({ contextWindow: 128_000, maxOutput: 8_192 }, 10_000)).toBe(8_192)
    // 128k - 11k - 1024 > 32k → 32k 上限生效。
    expect(consolidationMaxTokens({ contextWindow: 128_000, maxOutput: 0 }, 100)).toBe(32_768)
    // 上下文塞满 → 保底 1024。
    expect(consolidationMaxTokens({ contextWindow: 8_000, maxOutput: 0 }, 7_999)).toBe(1024)
  })
})

describe('renderSessions', () => {
  it('会话最旧在前、组内 ts 升序、字段全渲染', () => {
    const text = renderSessions([
      {
        sessionId: 'b',
        deltas: [
          { delta: delta({ ts: 9, statement: 'B2' }), file: 'f2' },
          { delta: delta({ ts: 8, statement: 'B1' }), file: 'f1' },
        ],
      },
      { sessionId: 'a', deltas: [{ delta: delta({ ts: 1, statement: 'A1' }), file: 'f0' }] },
    ])
    const sessionA = text.indexOf('### session a')
    const sessionB = text.indexOf('### session b')
    expect(sessionA).toBeGreaterThanOrEqual(0)
    expect(sessionA).toBeLessThan(sessionB)
    expect(text.indexOf('B1')).toBeLessThan(text.indexOf('B2'))
    expect(text).toContain('kind=constraint')
    expect(text).toContain('friction(corrective=true, regression=false, subtle=false)')
  })
})

describe('runConsolidation', () => {
  it('未到期返回 not_due（force 跳过检查）', async () => {
    const state: SharpshooterState = { v: 1, lastConsolidatedAt: Date.now() }
    const { writeState } = await import('./storage.js')
    await writeState(root, '/proj', state)
    const notDue = await runConsolidation({
      registry: fakeRegistry(),
      config: fakeConfig(),
      memoriesRoot: root,
      cwd: '/proj',
      llmCall: llmReturning([]),
    })
    expect(notDue).toEqual({ ran: false, reason: 'not_due' })
  })

  it('空队列推进窗口并返回 empty', async () => {
    const result = await runConsolidation({
      registry: fakeRegistry(),
      config: fakeConfig(),
      memoriesRoot: root,
      cwd: '/proj',
      llmCall: llmReturning([]),
    })
    expect(result).toEqual({ ran: false, reason: 'empty' })
    expect(readState(root, '/proj').lastConsolidatedAt).toBeGreaterThan(0)
  })

  it('持锁期间返回 locked', async () => {
    await appendDelta(root, '/proj', delta())
    const lock = await acquireBankLock(root, '/proj', 'consolidate')
    expect(lock).not.toBeNull()
    const result = await runConsolidation({
      registry: fakeRegistry(),
      config: fakeConfig(),
      memoriesRoot: root,
      cwd: '/proj',
      force: true,
      llmCall: llmReturning([]),
    })
    expect(result).toEqual({ ran: false, reason: 'locked' })
    await lock?.release()
  })

  it('整文件重写三个 md + 消费 delta + 写 state', async () => {
    await appendDelta(root, '/proj', delta())
    await appendDelta(root, '/proj', delta({ sessionId: 'sess-2', ts: 2_000 }))
    const result = await runConsolidation({
      registry: fakeRegistry(),
      config: fakeConfig(),
      memoriesRoot: root,
      cwd: '/proj',
      force: true,
      llmCall: llmReturning([
        validFilesTool({ 'architecture.md': '## Decisions\n- Postgres over sqlite' }),
      ]),
    })
    expect(result).toEqual({ ran: true, sessions: 2, deltas: 2 })
    const bankId = (await import('./storage.js')).projectBankSegment('/proj')
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(join(root, 'sharpshooter', bankId, 'architecture.md'), 'utf-8')
    expect(content).toBe('## Decisions\n- Postgres over sqlite')
    // 队列被消费干净。
    expect(await listDeltas(root, '/proj')).toHaveLength(0)
    const state = readState(root, '/proj')
    expect(state.lastResult?.deltas).toBe(2)
    expect(state.lastResult?.sessions).toBe(2)
    expect(state.lastResult?.model).toBe('m1')
  })

  it('崩溃幂等：已应用的文件 + 未消费的 delta 重跑可收敛', async () => {
    // 模拟 apply 后、consume 前崩溃：文件已写，delta 仍在队列。
    await appendDelta(root, '/proj', delta())
    const bankId = (await import('./storage.js')).projectBankSegment('/proj')
    const bank = join(root, 'sharpshooter', bankId)
    mkdirSync(bank, { recursive: true })
    writeFileSync(join(bank, 'architecture.md'), '## Decisions\n- stale content')
    const result = await runConsolidation({
      registry: fakeRegistry(),
      config: fakeConfig(),
      memoriesRoot: root,
      cwd: '/proj',
      force: true,
      llmCall: llmReturning([
        validFilesTool({ 'architecture.md': '## Decisions\n- fresh content' }),
      ]),
    })
    expect(result.ran).toBe(true)
    expect(await listDeltas(root, '/proj')).toHaveLength(0)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(bank, 'architecture.md'), 'utf-8')).toBe(
      '## Decisions\n- fresh content',
    )
  })

  it('非法输出（两次调用/重复名/超行数/全空清空）报 error 且 delta 保留', async () => {
    await appendDelta(root, '/proj', delta())
    const base = {
      registry: fakeRegistry(),
      config: fakeConfig(),
      memoriesRoot: root,
      cwd: '/proj',
      force: true,
    } as const
    const twice = await runConsolidation({
      ...base,
      llmCall: llmReturning([validFilesTool(), validFilesTool()]),
    })
    expect(twice.ran).toBe(false)
    expect(twice.reason).toBe('error')
    expect(await listDeltas(root, '/proj')).toHaveLength(1)

    const dupNames = await runConsolidation({
      ...base,
      llmCall: llmReturning([
        {
          name: 'replace_memory_files',
          arguments: {
            files: [
              { name: 'architecture.md', content: 'x' },
              { name: 'architecture.md', content: 'y' },
              { name: 'product.md', content: '' },
              { name: 'style.md', content: '' },
            ],
          },
        },
      ]),
    })
    expect(dupNames.reason).toBe('error')

    // maxFileLines=3：4 行超限。
    const overLimit = await runConsolidation({
      ...base,
      llmCall: llmReturning([validFilesTool({ 'product.md': 'a\nb\nc\nd' })]),
    })
    expect(overLimit.reason).toBe('error')

    // 当前非空时全空输出拒绝（防误清空）。
    const bankId = (await import('./storage.js')).projectBankSegment('/proj')
    const bank = join(root, 'sharpshooter', bankId)
    mkdirSync(bank, { recursive: true })
    writeFileSync(join(bank, 'style.md'), 'existing content')
    const wipe = await runConsolidation({ ...base, llmCall: llmReturning([validFilesTool()]) })
    expect(wipe.reason).toBe('error')

    // 失败计数进 state（退避依据）。
    const state = readState(root, '/proj')
    expect(state.lastError?.failures).toBeGreaterThanOrEqual(4)
  })

  it('输出经凭证脱敏', async () => {
    await appendDelta(root, '/proj', delta())
    const result = await runConsolidation({
      registry: fakeRegistry(),
      config: fakeConfig(),
      memoriesRoot: root,
      cwd: '/proj',
      force: true,
      llmCall: llmReturning([
        validFilesTool({ 'product.md': 'key is token_aB3dEfGh1JkLmNoP end' }),
      ]),
    })
    expect(result.ran).toBe(true)
    const bankId = (await import('./storage.js')).projectBankSegment('/proj')
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(join(root, 'sharpshooter', bankId, 'product.md'), 'utf-8')
    expect(content).toContain('[REDACTED]')
    expect(content).not.toContain('aB3dEfGh1JkLmNoP')
  })

  it('provider 未配置返回 no_model', async () => {
    await appendDelta(root, '/proj', delta())
    const emptyRegistry = createRegistry()
    const result = await runConsolidation({
      registry: emptyRegistry,
      config: fakeConfig(),
      memoriesRoot: root,
      cwd: '/proj',
      force: true,
      llmCall: llmReturning([]),
    })
    expect(result).toEqual({ ran: false, reason: 'no_model' })
  })
})

describe('parseReplacementFiles', () => {
  const current = { 'architecture.md': '', 'product.md': '', 'style.md': '' }

  it('合法输入按名去序返回（未提及的文件为空串）', () => {
    const files = parseReplacementFiles([validFilesTool({ 'style.md': 's' })], current, 120)
    expect(files).toEqual([
      { name: 'architecture.md', content: '' },
      { name: 'product.md', content: '' },
      { name: 'style.md', content: 's' },
    ])
  })

  it('非 replace_memory_files 调用被忽略后报缺', () => {
    expect(() => parseReplacementFiles([{ name: 'other', arguments: {} }], current, 120)).toThrow(
      /exactly once/,
    )
  })
})
