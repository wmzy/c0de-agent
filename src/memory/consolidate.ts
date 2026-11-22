// 整合阶段：队列 delta → 三个决策文件的整文件重写。
//
// 到期检查（指数退避 clamp [1min, 6h]）→ bank 锁内读三文件现状 + 项目文档
// （6000 token 上限）+ 全部队列 delta 按会话分组渲染 → 单次 LLM 调用强制
// replace_memory_files 整文件重写 → 校验/脱敏/行数上限 → 原子应用 → 消费
// delta 文件 → 写 state.json。apply 与 unlink 之间崩溃只是重投（整合幂等）。

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getLogger } from '../core/logger.js'
import type { Registry } from '../llm/registry.js'
import { estimateTokens } from '../llm/token.js'
import type { ChatTool } from '../shared/types/llm.js'
import { redactSecretText } from '../shared/utils/secret-redact.js'
import {
  callToolRequired,
  type MemoryLlmCall,
  type MemoryLlmConfig,
  resolveMemoryModel,
  resolveModelCaps,
  routeAvailable,
} from './llm-call.js'
import { renderConsolidateInput, renderConsolidateSystem } from './prompts.js'
import { resolveMemorySettings } from './settings.js'
import {
  acquireBankLock,
  bankDir,
  consumeDeltas,
  listDeltas,
  memoryFilePath,
  readState,
  type SharpshooterSessionDeltas,
  writeState,
} from './storage.js'
import {
  SHARPSHOOTER_MEMORY_FILES,
  type SharpshooterMemoryFile,
  type SharpshooterState,
} from './types.js'

const logger = getLogger('memory.consolidate')

/** 项目文档（AGENTS.md/CLAUDE.md）进整合输入的近似 token 上限：
 *  只用于「已文档化 → 排除」判重，6000 token 足够覆盖开头约定部分。 */
const PROJECT_DOC_TOKEN_LIMIT = 6000

/** 单次整合回复的输出预算上限：三文件在 maxFileLines 行天花板下的完整重写。 */
const CONSOLIDATION_MAX_TOKENS = 32_768

/** prompt 塞满上下文时保底的最小输出预算。 */
const MIN_CONSOLIDATION_MAX_TOKENS = 1024

/** 工具 schema 与消息框架的固定补贴（本地 token 估算不含这些）。 */
const PROMPT_FRAMING_TOKENS = 1024

/** 整合失败后的重试退避上下限。 */
const MIN_RETRY_BACKOFF_MS = 60_000
const MAX_RETRY_BACKOFF_MS = 6 * 60 * 60_000

/** replace_memory_files 工具的 JSON Schema（整合的唯一出口）。 */
export const REPLACE_MEMORY_FILES_TOOL: ChatTool = {
  name: 'replace_memory_files',
  description:
    'Replace complete sharpshooter memory files after consolidating queued decision deltas.',
  parameters: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: [...SHARPSHOOTER_MEMORY_FILES] },
            content: { type: 'string' },
          },
          required: ['name', 'content'],
        },
      },
    },
    required: ['files'],
  },
}

export interface ConsolidationResult {
  ran: boolean
  reason?: 'not_due' | 'locked' | 'empty' | 'no_model' | 'error'
  sessions?: number
  deltas?: number
  error?: string
}

interface ReplacementFile {
  name: SharpshooterMemoryFile
  content: string
}

/** 队列 delta 按会话分组渲染进整合输入：会话最旧在前，组内按 ts 升序。 */
export function renderSessions(groups: readonly SharpshooterSessionDeltas[]): string {
  return [...groups]
    .sort((a, b) => (a.deltas[0]?.delta.ts ?? 0) - (b.deltas[0]?.delta.ts ?? 0))
    .map((group) => {
      const lines = [...group.deltas]
        .sort((a, b) => a.delta.ts - b.delta.ts)
        .map(({ delta }) => {
          const fields = [
            `kind=${delta.kind}`,
            `statement=${JSON.stringify(delta.statement)}`,
            `evidence=${JSON.stringify(delta.evidence)}`,
            `source=${delta.source}`,
            `friction(corrective=${delta.friction.corrective}, regression=${delta.friction.regression}, subtle=${delta.friction.subtle})`,
          ]
          if (delta.rejectedAlternative) {
            fields.push(`rejectedAlternative=${JSON.stringify(delta.rejectedAlternative)}`)
          }
          if (delta.rationale) fields.push(`rationale=${JSON.stringify(delta.rationale)}`)
          return `- ${fields.join('; ')}`
        })
      return [`### session ${group.sessionId}`, ...lines].join('\n')
    })
    .join('\n\n')
}

/** 自上次成功以来的连续失败数；早于上次成功的错误是陈旧记录，不计数。 */
export function consecutiveFailures(state: SharpshooterState): number {
  const error = state.lastError
  if (!error || error.at < state.lastConsolidatedAt) return 0
  return error.failures ?? 1
}

/** 非强制整合最早可跑的时刻：上次成功 + interval；连续失败后再叠加
 *  interval×2^(failures-1) 的退避（clamp [1min, 6h]）——失败的 bank 不会
 *  每个调度 tick 都把全部输入重发一遍。 */
export function nextConsolidationAt(state: SharpshooterState, intervalMinutes: number): number {
  const intervalMs = Math.max(0, intervalMinutes) * 60_000
  const next = state.lastConsolidatedAt + intervalMs
  const failures = consecutiveFailures(state)
  if (failures === 0 || !state.lastError) return next
  const backoffMs = Math.min(
    MAX_RETRY_BACKOFF_MS,
    Math.max(MIN_RETRY_BACKOFF_MS, intervalMs) * 2 ** (failures - 1),
  )
  return Math.max(next, state.lastError.at + backoffMs)
}

/** 按模型能力与 prompt 体量算输出预算：min(32k, maxOutput, 上下文剩余)，
 *  下限 1024；上下文预留按估算 +10% + 1024 框架补贴（本地估算 ≠ 模型分词）。 */
export function consolidationMaxTokens(
  caps: { contextWindow: number; maxOutput: number },
  promptTokens: number,
): number {
  let budget = CONSOLIDATION_MAX_TOKENS
  if (caps.maxOutput > 0) budget = Math.min(budget, caps.maxOutput)
  if (caps.contextWindow > 0) {
    const reserved = promptTokens + Math.ceil(promptTokens / 10) + PROMPT_FRAMING_TOKENS
    budget = Math.min(budget, caps.contextWindow - reserved)
  }
  return Math.max(MIN_CONSOLIDATION_MAX_TOKENS, budget)
}

/** 近似 token 截断（omp 口径：token×4 字符 + 省略号；CJK 下偏保守即安全）。 */
export function truncateApproxTokens(text: string, tokenLimit: number): string {
  const maxChars = Math.max(0, tokenLimit * 4)
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

/** 运行一次整合（到期检查 + 全流程）。返回结构化结果，绝不向调用方抛错——
 *  失败一律落进 state.lastError 供退避与诊断。 */
export async function runConsolidation(opts: {
  registry: Registry
  config: MemoryLlmConfig
  memoriesRoot: string
  cwd: string
  force?: boolean
  /** 依赖注入（测试 fake）；缺省走真实 LLM。 */
  llmCall?: MemoryLlmCall
  /** 成功应用后的回调（backend 借此失效注入缓存）。 */
  onApplied?: () => void
  signal?: AbortSignal
}): Promise<ConsolidationResult> {
  try {
    await fs.mkdir(bankDir(opts.memoriesRoot, opts.cwd), { recursive: true })
  } catch (error) {
    return { ran: false, reason: 'error', error: errorMessage(error) }
  }

  const lock = await acquireBankLock(opts.memoriesRoot, opts.cwd, 'consolidate')
  if (!lock) return { ran: false, reason: 'locked' }
  try {
    return await consolidateLocked(opts)
  } finally {
    await lock.release()
  }
}

async function consolidateLocked(opts: {
  registry: Registry
  config: MemoryLlmConfig
  memoriesRoot: string
  cwd: string
  force?: boolean
  llmCall?: MemoryLlmCall
  onApplied?: () => void
  signal?: AbortSignal
}): Promise<ConsolidationResult> {
  const { memoriesRoot, cwd } = opts
  const settings = resolveMemorySettings(opts.config)
  const state = readState(memoriesRoot, cwd)
  try {
    if (
      !opts.force &&
      Date.now() < nextConsolidationAt(state, settings.sharpshooter.intervalMinutes)
    ) {
      return { ran: false, reason: 'not_due' }
    }

    const groups = await listDeltas(memoriesRoot, cwd)
    if (groups.length === 0) {
      // 空队列也推进窗口：否则队列恒空的 bank 每 tick 都重跑到期检查。
      await writeState(memoriesRoot, cwd, { ...state, lastConsolidatedAt: Date.now() })
      return { ran: false, reason: 'empty' }
    }

    const { provider, model } = resolveMemoryModel(opts.config)
    if (!routeAvailable(opts.registry, provider, model)) {
      return { ran: false, reason: 'no_model' }
    }

    const current = await readCurrentFiles(memoriesRoot, cwd)
    const projectDocs = await readProjectDocs(cwd)
    const input = renderConsolidateInput({
      current,
      projectDocs,
      sessions: renderSessions(groups),
    })
    const system = renderConsolidateSystem(settings.sharpshooter.maxFileLines)

    const caps = resolveModelCaps(opts.registry, provider, model)
    const maxTokens = consolidationMaxTokens(caps, estimateTokens(`${system}\n${input}`))
    const llm = opts.llmCall ?? callToolRequired
    const response = await llm({
      registry: opts.registry,
      config: opts.config,
      system,
      input,
      tool: REPLACE_MEMORY_FILES_TOOL,
      maxTokens,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (response.finishReason === 'length') {
      throw new Error(`consolidation response truncated at the ${maxTokens}-token output limit`)
    }

    const files = parseReplacementFiles(
      response.toolCalls,
      current,
      settings.sharpshooter.maxFileLines,
    )
    await applyReplacementFiles(bankDir(memoriesRoot, cwd), files)
    opts.onApplied?.()

    const consumed = groups.flatMap((group) => group.deltas.map((item) => item.file))
    await consumeDeltas(consumed)
    const at = Date.now()
    await writeState(memoriesRoot, cwd, {
      v: 1,
      lastConsolidatedAt: at,
      lastResult: { at, sessions: groups.length, deltas: consumed.length, model },
    })
    return { ran: true, sessions: groups.length, deltas: consumed.length }
  } catch (error) {
    const message = errorMessage(error)
    await recordConsolidationError(memoriesRoot, cwd, state, message)
    return { ran: false, reason: 'error', error: message }
  }
}

async function readCurrentFiles(
  memoriesRoot: string,
  cwd: string,
): Promise<Record<SharpshooterMemoryFile, string>> {
  const files = {
    'architecture.md': '',
    'product.md': '',
    'style.md': '',
  } as Record<SharpshooterMemoryFile, string>
  await Promise.all(
    SHARPSHOOTER_MEMORY_FILES.map(async (name) => {
      files[name] = await fs
        .readFile(memoryFilePath(memoriesRoot, cwd, name), 'utf-8')
        .catch(() => '')
    }),
  )
  return files
}

async function readProjectDocs(cwd: string): Promise<string> {
  const blocks: string[] = []
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const content = await fs.readFile(join(cwd, name), 'utf-8').catch(() => '')
    if (content.trim()) blocks.push(`--- ${name} ---\n${content.trim()}`)
  }
  return truncateApproxTokens(blocks.join('\n\n'), PROJECT_DOC_TOKEN_LIMIT)
}

function isMemoryFileName(value: unknown): value is SharpshooterMemoryFile {
  return (
    typeof value === 'string' && (SHARPSHOOTER_MEMORY_FILES as readonly string[]).includes(value)
  )
}

/** 整合输出的严格校验：恰好一次 replace_memory_files、名字合法且不重复、
 *  content 逐文件脱敏、行数不超上限、全空输出拒绝清空非空记忆。 */
export function parseReplacementFiles(
  toolCalls: readonly { name: string; arguments: unknown }[],
  currentFiles: Readonly<Record<SharpshooterMemoryFile, string>>,
  maxFileLines: number,
): ReplacementFile[] {
  const calls = toolCalls.filter((call) => call.name === REPLACE_MEMORY_FILES_TOOL.name)
  const call = calls.length === 1 ? calls[0] : undefined
  if (!call) {
    throw new Error('consolidation must call replace_memory_files exactly once')
  }
  const args = call.arguments as { files?: unknown } | null
  if (!args || typeof args !== 'object' || !Array.isArray(args.files)) {
    throw new Error('replace_memory_files requires a files array')
  }

  const seen = new Set<SharpshooterMemoryFile>()
  const files: ReplacementFile[] = []
  for (const item of args.files) {
    if (!item || typeof item !== 'object' || !('name' in item) || !('content' in item)) {
      throw new Error('replace_memory_files contains an invalid file entry')
    }
    const entry = item as { name: unknown; content: unknown }
    if (!isMemoryFileName(entry.name) || typeof entry.content !== 'string') {
      throw new Error('replace_memory_files contains an invalid file entry')
    }
    if (seen.has(entry.name))
      throw new Error(`replace_memory_files contains duplicate ${entry.name}`)
    seen.add(entry.name)
    const redacted = redactSecretText(entry.content)
    const lines = redacted.length > 0 ? redacted.split('\n').length : 0
    if (lines > maxFileLines) {
      throw new Error(`${entry.name} exceeds the ${maxFileLines}-line limit`)
    }
    files.push({ name: entry.name, content: redacted })
  }
  const totalChars = files.reduce((sum, file) => sum + file.content.trim().length, 0)
  if (
    totalChars === 0 &&
    SHARPSHOOTER_MEMORY_FILES.some((name) => currentFiles[name].trim().length > 0)
  ) {
    throw new Error(
      'replace_memory_files returned all-empty content; refusing to wipe memory files',
    )
  }
  return files
}

/** 原子应用：先写同目录临时文件再 rename，读侧任何时刻看到的都是完整旧/新文件。 */
async function applyReplacementFiles(
  dir: string,
  files: readonly ReplacementFile[],
): Promise<void> {
  const staged = files.map((file) => ({
    ...file,
    tempPath: join(dir, `.${file.name}.${process.pid}.${randomUUID()}.tmp`),
  }))
  try {
    for (const file of staged) {
      await fs.mkdir(dirname(file.tempPath), { recursive: true })
      await fs.writeFile(file.tempPath, file.content, 'utf-8')
    }
    for (const file of staged) await fs.rename(file.tempPath, join(dir, file.name))
  } finally {
    await Promise.all(staged.map((file) => fs.rm(file.tempPath, { force: true }).catch(() => {})))
  }
}

async function recordConsolidationError(
  memoriesRoot: string,
  cwd: string,
  state: SharpshooterState,
  message: string,
): Promise<void> {
  try {
    await writeState(memoriesRoot, cwd, {
      ...state,
      lastError: { at: Date.now(), message, failures: consecutiveFailures(state) + 1 },
    })
  } catch (error) {
    // 原始整合错误比二次写 state 失败更有诊断价值，只留日志。
    logger.warn(`consolidation error state write failed: ${errorMessage(error)}`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
