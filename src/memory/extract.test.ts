import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRegistry, type Registry, registerProvider } from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'
import {
  admitDelta,
  buildExtractionEnvelope,
  cleanEnvelopeContext,
  countGraphemes,
  type MemoryMessage,
  passesExtractionGate,
  runExtraction,
} from './extract.js'
import type { MemoryLlmCall, MemoryToolCallResult } from './llm-call.js'
import { listDeltas } from './storage.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-extract-'))
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

const CANDIDATE = {
  kind: 'constraint',
  statement: 'Never store secrets in memory files',
  source: 'explicit_user',
  evidence: 'never store secrets',
  friction: { corrective: false, regression: false, subtle: true },
}

describe('extraction gate', () => {
  it('slash 命令与过短 prompt 被拒', () => {
    expect(passesExtractionGate('/compact', 16)).toBe(false)
    expect(passesExtractionGate('  /review  now', 16)).toBe(false)
    expect(passesExtractionGate('ok', 16)).toBe(false)
    expect(passesExtractionGate('这是一个足够长的、值得提取的用户决策陈述', 16)).toBe(true)
  })

  it('grapheme 计数而非 UTF-16 长度', () => {
    expect(countGraphemes('👍👍')).toBe(2)
    expect(countGraphemes('你好')).toBe(2)
    // 8 个 emoji 按 .length 计 16，但 grapheme 只有 8 —— 不该过 16 门槛。
    expect(passesExtractionGate('👍'.repeat(8), 16)).toBe(false)
    expect(passesExtractionGate('👍'.repeat(16), 16)).toBe(true)
  })
})

describe('buildExtractionEnvelope', () => {
  it('缺省取最后一条 user；上条 user/assistant 各自最近者优先', () => {
    const messages: MemoryMessage[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'final answer' },
      { role: 'user', content: 'the decision prompt' },
    ]
    const envelope = buildExtractionEnvelope(messages)
    expect(envelope?.prompt).toBe('the decision prompt')
    expect(envelope?.previousHuman).toBe('second question')
    expect(envelope?.assistantContext).toBe('final answer')
  })

  it('无 user 消息返回 undefined；current 指定时以其为准', () => {
    expect(buildExtractionEnvelope([{ role: 'assistant', content: 'x' }])).toBeUndefined()
    const current: MemoryMessage = { role: 'user', content: 'current prompt' }
    const envelope = buildExtractionEnvelope([{ role: 'user', content: 'older' }], current)
    expect(envelope?.prompt).toBe('current prompt')
    expect(envelope?.previousHuman).toBe('older')
  })

  it('上下文裁剪：代码块折叠、空白压平、400/800 上限', () => {
    expect(cleanEnvelopeContext('a\n\n  b\t\tc', 100)).toBe('a b c')
    const withCode = cleanEnvelopeContext('before\n```ts\nconst a = 1\n```\nafter', 100)
    expect(withCode).toBe('before [code omitted] after')
    expect(cleanEnvelopeContext('```ts\ncode only\n```', 100)).toBe('[code omitted]')
    expect(cleanEnvelopeContext('   ', 100)).toBeUndefined()
    expect(cleanEnvelopeContext('x'.repeat(500), 400)).toHaveLength(400)
    expect(cleanEnvelopeContext('y'.repeat(900), 800)).toHaveLength(800)
  })
})

describe('admitDelta', () => {
  const PROMPT = 'please never store secrets in memory files, that is a hard constraint'

  it('evidence 必须是 prompt 精确子串，否则丢弃', () => {
    expect(admitDelta(CANDIDATE, PROMPT, 's1')).toBeDefined()
    expect(
      admitDelta({ ...CANDIDATE, evidence: 'never store secrets' }, PROMPT, 's1'),
    ).toBeDefined()
    expect(
      admitDelta({ ...CANDIDATE, evidence: 'NEVER STORE SECRETS' }, PROMPT, 's1'),
    ).toBeUndefined()
    expect(
      admitDelta({ ...CANDIDATE, evidence: 'not in the prompt' }, PROMPT, 's1'),
    ).toBeUndefined()
    expect(admitDelta({ ...CANDIDATE, evidence: '' }, PROMPT, 's1')).toBeUndefined()
  })

  it('非法 kind/source/friction/空 statement 均丢弃', () => {
    expect(admitDelta({ ...CANDIDATE, kind: 'vibe' }, PROMPT, 's1')).toBeUndefined()
    expect(admitDelta({ ...CANDIDATE, source: 'guess' }, PROMPT, 's1')).toBeUndefined()
    expect(
      admitDelta({ ...CANDIDATE, friction: { corrective: true } }, PROMPT, 's1'),
    ).toBeUndefined()
    expect(admitDelta({ ...CANDIDATE, statement: '   ' }, PROMPT, 's1')).toBeUndefined()
    expect(admitDelta(null, PROMPT, 's1')).toBeUndefined()
  })

  it('入队前对文本字段做凭证脱敏', () => {
    const delta = admitDelta(
      {
        ...CANDIDATE,
        statement: 'use token_aB3dEfGh1JkLmNoP as documented',
        evidence: 'token_aB3dEfGh1JkLmNoP',
      },
      'token_aB3dEfGh1JkLmNoP is the key',
      's1',
    )
    expect(delta?.statement).not.toContain('aB3dEfGh1JkLmNoP')
    expect(delta?.statement).toContain('[REDACTED]')
    expect(delta?.evidence).toBe('[REDACTED]')
  })
})

describe('runExtraction', () => {
  it('合法 delta 入队、非法丢弃，malformed 工具调用跳过', async () => {
    const admitted = await runExtraction({
      registry: fakeRegistry(),
      config: fakeConfig(),
      memoriesRoot: root,
      cwd: '/proj',
      sessionId: 'sess-A',
      envelope: { prompt: 'we chose postgres over sqlite for durability' },
      llmCall: llmReturning([
        {
          name: 'record_deltas',
          arguments: {
            deltas: [
              {
                kind: 'architecture_decision',
                statement: 'Postgres over sqlite for durability',
                source: 'explicit_user',
                evidence: 'postgres over sqlite',
                friction: { corrective: false, regression: false, subtle: true },
              },
              {
                kind: 'architecture_decision',
                statement: 'Bad evidence delta',
                source: 'explicit_user',
                evidence: 'not a substring',
                friction: { corrective: false, regression: false, subtle: false },
              },
            ],
          },
        },
        { name: 'record_deltas', arguments: { nope: true } },
      ]),
    })
    expect(admitted).toBe(1)
    const groups = await listDeltas(root, '/proj')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.sessionId).toBe('sess-A')
    expect(groups[0]?.deltas[0]?.delta.statement).toBe('Postgres over sqlite for durability')
  })
})
