import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRegistry, type Registry, registerProvider } from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'
import { createSharpshooterBackend, startScheduler } from './backend.js'
import { createLearnTool } from './learn.js'
import type { MemoryLlmCall, MemoryToolCallResult } from './llm-call.js'
import { resolveMemorySettings } from './settings.js'
import { appendDelta, projectBankSegment } from './storage.js'
import { SHARPSHOOTER_MEMORY_FILES } from './types.js'

let root: string

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-backend-'))
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
        maxFileLines: 120,
      },
      ...memory,
    },
  }
}

function llmReturning(toolCalls: { name: string; arguments: unknown }[]): MemoryLlmCall {
  return async (): Promise<MemoryToolCallResult> => ({ toolCalls, finishReason: 'tool-calls' })
}

const EXTRACT_TOOL_CALL = {
  name: 'record_deltas',
  arguments: {
    deltas: [
      {
        kind: 'constraint',
        statement: 'Never store secrets in memory files',
        source: 'explicit_user',
        evidence: 'never store secrets',
        friction: { corrective: false, regression: false, subtle: true },
      },
    ],
  },
}

function replaceTool(content: Partial<Record<string, string>>): {
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

function writeBankFile(cwd: string, file: string, content: string): void {
  const bank = join(root, 'sharpshooter', projectBankSegment(cwd))
  mkdirSync(bank, { recursive: true })
  writeFileSync(join(bank, file), content)
}

describe('resolveMemorySettings', () => {
  it('缺省回退默认、非法值兜底、backend 只认 sharpshooter', () => {
    expect(resolveMemorySettings({} as Config)).toEqual({
      backend: 'off',
      sharpshooter: {
        intervalMinutes: 5,
        minPromptLength: 16,
        injectionTokenLimit: 15000,
        maxFileLines: 120,
      },
    })
    const bad = resolveMemorySettings({
      memory: {
        backend: 'sharpshooter',
        sharpshooter: { intervalMinutes: 'x' as unknown as number, minPromptLength: -3 },
      },
    } as Config)
    expect(bad.backend).toBe('sharpshooter')
    expect(bad.sharpshooter.intervalMinutes).toBe(5)
    expect(bad.sharpshooter.minPromptLength).toBe(16)
  })
})

describe('loadContext', () => {
  it('全空返回 null；有内容时带头部与 follow-unless-overridden 指引', async () => {
    const backend = createSharpshooterBackend(fakeConfig(), {
      memoriesRoot: root,
      getRegistry: fakeRegistry,
      llmCall: llmReturning([]),
    })
    // 注入缓存是模块级共享（同 root 同 bank），空/有内容两段用不同 bank 隔离。
    expect(await backend.loadContext('/proj-empty')).toBeNull()

    // 新 backend 读有内容的 bank。
    writeBankFile('/proj', 'architecture.md', '## Decisions\n- Postgres over sqlite')
    writeBankFile('/proj', 'learned.md', '- Use biome formatting\n  - corrected twice')
    const fresh = createSharpshooterBackend(fakeConfig(), {
      memoriesRoot: root,
      getRegistry: fakeRegistry,
      llmCall: llmReturning([]),
    })
    const text = await fresh.loadContext('/proj')
    expect(text).toContain('# Project decision memory (sharpshooter)')
    expect(text).toContain('follow them unless the user explicitly overrides')
    expect(text).toContain('## architecture')
    expect(text).toContain('- Postgres over sqlite')
    expect(text).toContain('## learned')
    expect(text).toContain('Use biome formatting (corrected twice)')
    expect(text).not.toContain('## product\n\n')
  })

  it('injectionTokenLimit 预算截断（近似 token×4 字符）', async () => {
    const backend = createSharpshooterBackend(
      fakeConfig({
        sharpshooter: {
          intervalMinutes: 5,
          minPromptLength: 16,
          injectionTokenLimit: 10,
          maxFileLines: 120,
        },
      }),
      { memoriesRoot: root, llmCall: llmReturning([]) },
    )
    writeBankFile('/proj', 'style.md', 'x'.repeat(200))
    const text = await backend.loadContext('/proj')
    // 10 token ≈ 40 字符：头 + 截断标记。
    expect(text).not.toBeNull()
    expect((text ?? '').length).toBeLessThanOrEqual(41)
    expect(text).toContain('…')
  })
})

describe('注入缓存失效', () => {
  it('外部写盘不重算（缓存命中）；delta 入队与整合应用后失效重算', async () => {
    const backend = createSharpshooterBackend(fakeConfig(), {
      memoriesRoot: root,
      getRegistry: fakeRegistry,
      llmCall: llmReturning([EXTRACT_TOOL_CALL]),
    })
    expect(await backend.loadContext('/proj')).toBeNull()
    // 缓存命中：外部写盘不可见（同进程失效只在 delta/整合路径触发）。
    writeBankFile('/proj', 'architecture.md', 'external write')
    expect(await backend.loadContext('/proj')).toBeNull()

    // 提取入队 delta → 缓存失效。重算会看到外部写入的文件（失效即重算，
    // 队列 delta 本身不进注入文本，等整合落到文件后才可见）。
    backend.startExtractor({
      sessionId: 's1',
      cwd: '/proj',
      messages: [{ role: 'user', content: 'please never store secrets in memory files' }],
    })
    await backend.flushExtraction()
    const { queueDepth } = await import('./storage.js')
    expect(await queueDepth(root, '/proj')).toBe(1)
    const afterDelta = await backend.loadContext('/proj')
    expect(afterDelta).toContain('external write')

    // 整合应用 → onApplied 失效 → 新文件内容可见。
    const consolidating = createSharpshooterBackend(fakeConfig(), {
      memoriesRoot: root,
      getRegistry: fakeRegistry,
      llmCall: llmReturning([replaceTool({ 'architecture.md': '## after consolidation' })]),
    })
    const result = await consolidating.runConsolidationNow('/proj')
    expect(result.ran).toBe(true)
    const text = await consolidating.loadContext('/proj')
    expect(text).toContain('## after consolidation')
  })
})

describe('startExtractor', () => {
  it('fire-and-forget：门槛不过（slash/过短）直接跳过', async () => {
    const llm = vi.fn(llmReturning([EXTRACT_TOOL_CALL]))
    const backend = createSharpshooterBackend(fakeConfig(), {
      memoriesRoot: root,
      getRegistry: fakeRegistry,
      llmCall: llm as unknown as MemoryLlmCall,
    })
    backend.startExtractor({
      sessionId: 's1',
      cwd: '/proj',
      messages: [{ role: 'user', content: '/compact' }],
    })
    backend.startExtractor({
      sessionId: 's1',
      cwd: '/proj',
      messages: [{ role: 'user', content: 'ok' }],
    })
    await backend.flushExtraction()
    expect(llm).not.toHaveBeenCalled()
  })

  it('LLM 失败被吞掉（best-effort），不影响后续', async () => {
    let calls = 0
    const failing: MemoryLlmCall = async () => {
      calls += 1
      throw new Error('provider down')
    }
    const backend = createSharpshooterBackend(fakeConfig(), {
      memoriesRoot: root,
      getRegistry: fakeRegistry,
      llmCall: failing,
    })
    backend.startExtractor({
      sessionId: 's1',
      cwd: '/proj',
      messages: [{ role: 'user', content: 'we decided postgres over sqlite for durability' }],
    })
    await backend.flushExtraction()
    expect(calls).toBe(1)
    // 第二次提取照常发起（失败不粘住管线）。
    backend.startExtractor({
      sessionId: 's1',
      cwd: '/proj',
      messages: [{ role: 'user', content: 'another decision about the product scope' }],
    })
    await backend.flushExtraction()
    expect(calls).toBe(2)
  })
})

describe('learn 工具', () => {
  it('经 backend 落盘 learned.md 并失效注入缓存', async () => {
    const backend = createSharpshooterBackend(fakeConfig(), {
      memoriesRoot: root,
      getRegistry: fakeRegistry,
      llmCall: llmReturning([]),
    })
    expect(await backend.loadContext('/proj')).toBeNull()
    const tool = createLearnTool(backend)
    const result = await tool.execute(
      { memory: 'Use biome formatting', context: 'corrected twice' },
      { cwd: '/proj' } as Parameters<typeof tool.execute>[1],
    )
    expect(result._tag).toBe('success')
    const text = await backend.loadContext('/proj')
    expect(text).toContain('Use biome formatting (corrected twice)')

    // 空 memory 拒绝。
    const bad = await tool.execute({ memory: '  ' }, { cwd: '/proj' } as Parameters<
      typeof tool.execute
    >[1])
    expect(bad._tag).toBe('error')
  })

  it('permission 为 ask（写共享记忆不自动放行）', async () => {
    const backend = createSharpshooterBackend(fakeConfig(), {
      memoriesRoot: root,
      getRegistry: fakeRegistry,
      llmCall: llmReturning([]),
    })
    expect(createLearnTool(backend).permission).toBe('ask')
  })
})

describe('startScheduler', () => {
  it('到期 + 有队列 → tick 触发整合；stop 后不再触发', async () => {
    const llm = vi.fn(llmReturning([replaceTool({ 'product.md': '## scheduled' })]))
    const backend = createSharpshooterBackend(fakeConfig(), {
      memoriesRoot: root,
      getRegistry: fakeRegistry,
      llmCall: llm as unknown as MemoryLlmCall,
    })
    // 预置：队列 1 条 delta + state 恒过期（lastConsolidatedAt=0）。
    await appendDelta(root, '/proj', {
      v: 1,
      kind: 'constraint',
      statement: 'scheduled decision',
      source: 'explicit_user',
      evidence: 'x',
      friction: { corrective: false, regression: false, subtle: true },
      sessionId: 's1',
      ts: 1,
    })
    // 活跃 cwd 注册（loadContext 见过即注册）。
    await backend.loadContext('/proj')

    // 真实定时器 + 5ms tick：到期整合是幂等的（成功后 5 分钟内不再到期），
    // 多 tick 也不会重复打 LLM，断言稳定。
    const stop = startScheduler(backend, { intervalMs: 5 })
    await sleep(30)
    stop()
    expect(llm).toHaveBeenCalled()
    const bank = join(root, 'sharpshooter', projectBankSegment('/proj'))
    expect(await readFile(join(bank, 'product.md'), 'utf-8')).toBe('## scheduled')
    const ticks = llm.mock.calls.length
    await sleep(30)
    expect(llm.mock.calls.length).toBe(ticks)
  })

  it('未到期且队列为空 → tick 不打 LLM', async () => {
    const llm = vi.fn(llmReturning([]))
    const backend = createSharpshooterBackend(fakeConfig(), {
      memoriesRoot: root,
      getRegistry: fakeRegistry,
      llmCall: llm as unknown as MemoryLlmCall,
    })
    // 空队列 + state 记录「刚刚整合过」→ not_due。
    const { writeState } = await import('./storage.js')
    await writeState(root, '/proj', { v: 1, lastConsolidatedAt: Date.now() })
    await backend.loadContext('/proj')
    const stop = startScheduler(backend, { intervalMs: 5 })
    await sleep(30)
    stop()
    expect(llm).not.toHaveBeenCalled()
  })
})
