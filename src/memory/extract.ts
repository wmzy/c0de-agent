// 提取阶段：单条用户 prompt → SharpshooterDelta 队列。
//
// 门槛（slash 命令/过短 prompt 直接跳过）+ 有界 envelope（当前 prompt 全文 +
// 上条 user 400 字 + 上条 assistant 800 字，代码块折叠为 [code omitted]）+
// LLM 单发 toolChoice required + 逐条 admitDelta 宿主侧准入（evidence 必须是
// prompt 精确子串）——LLM 输出永远只当候选，落盘前全部本地校验 + 脱敏。

import { getLogger } from '../core/logger.js'
import type { Registry } from '../llm/registry.js'
import type { ChatTool } from '../shared/types/llm.js'
import { redactSecretText } from '../shared/utils/secret-redact.js'
import { callToolRequired, type MemoryLlmCall, type MemoryLlmConfig } from './llm-call.js'
import { EXTRACT_SYSTEM_PROMPT, renderExtractInput } from './prompts.js'
import { appendDelta } from './storage.js'
import type {
  SharpshooterDelta,
  SharpshooterDeltaKind,
  SharpshooterDeltaSource,
  SharpshooterFriction,
} from './types.js'

const logger = getLogger('memory.extract')

/** 管线视角的会话消息（宿主把内部消息映射成这个最小形状）。 */
export interface MemoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 提取输入：当前 prompt 全文 + 两条有界指代上下文。 */
export interface SharpshooterEnvelope {
  prompt: string
  previousHuman?: string
  assistantContext?: string
}

const SHARPSHOOTER_DELTA_KINDS: Record<SharpshooterDeltaKind, true> = {
  architecture_decision: true,
  product_decision: true,
  style_decision: true,
  constraint: true,
  rejected_approach: true,
  correction: true,
}

const SHARPSHOOTER_DELTA_SOURCES: Record<SharpshooterDeltaSource, true> = {
  explicit_user: true,
  contextual_resolution: true,
}

/** record_deltas 工具的 JSON Schema（LLM 的唯一出口）。 */
export const RECORD_DELTAS_TOOL: ChatTool = {
  name: 'record_deltas',
  description: 'Record every durable project-decision delta supported by the current user prompt.',
  parameters: {
    type: 'object',
    properties: {
      deltas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: [
                'architecture_decision',
                'product_decision',
                'style_decision',
                'constraint',
                'rejected_approach',
                'correction',
              ],
            },
            statement: { type: 'string' },
            rejectedAlternative: { type: 'string' },
            rationale: { type: 'string' },
            source: { type: 'string', enum: ['explicit_user', 'contextual_resolution'] },
            evidence: { type: 'string' },
            friction: {
              type: 'object',
              properties: {
                corrective: { type: 'boolean' },
                regression: { type: 'boolean' },
                subtle: { type: 'boolean' },
              },
              required: ['corrective', 'regression', 'subtle'],
            },
          },
          required: ['kind', 'statement', 'source', 'evidence', 'friction'],
        },
      },
    },
    required: ['deltas'],
  },
}

// 空 prompt 到不了长度门槛，floor=1 等于不过滤；2 是仍能滤掉单字应答（"好"、"y"）的最小值。
const MIN_PROMPT_LENGTH_FLOOR = 2

let segmenter: Intl.Segmenter | undefined

function getSegmenter(): Intl.Segmenter {
  // grapheme 计数避免把 "👍" 按 UTF-16 记 2 个字符（.length 口径）误判超长。
  segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' })
  return segmenter
}

export function countGraphemes(text: string): number {
  let count = 0
  for (const _ of getSegmenter().segment(text)) count += 1
  return count
}

/** 提取门槛：非 slash 命令、grapheme 数达 minPromptLength（下限 2）。 */
export function passesExtractionGate(prompt: string, minLength: number): boolean {
  const trimmed = prompt.trim()
  if (!trimmed || trimmed.startsWith('/')) return false
  return countGraphemes(trimmed) >= Math.max(MIN_PROMPT_LENGTH_FLOOR, minLength)
}

/** 上下文清洗：代码块折叠为 [code omitted]、空白压平、截断到 maxChars。 */
export function cleanEnvelopeContext(text: string, maxChars: number): string | undefined {
  const cleaned = text
    .replace(/(```|~~~)[\s\S]*?\1/g, '[code omitted]')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return undefined
  return cleaned.slice(0, maxChars)
}

/** 从会话快照构建提取 envelope：current 给出时以其为准，否则取最后一条 user。 */
export function buildExtractionEnvelope(
  messages: readonly MemoryMessage[],
  current?: MemoryMessage,
): SharpshooterEnvelope | undefined {
  let currentUserIndex = messages.length
  if (current) {
    const index = messages.lastIndexOf(current)
    currentUserIndex = index >= 0 ? index : messages.length
  } else {
    currentUserIndex = -1
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.role === 'user') {
        currentUserIndex = index
        break
      }
    }
    if (currentUserIndex < 0) return undefined
  }

  const currentMessage = current ?? messages[currentUserIndex]
  if (currentMessage?.role !== 'user') return undefined
  const currentPrompt = currentMessage.content.trim()
  if (!currentPrompt) return undefined

  // 上一条 user（400 字）与上一条 assistant（800 字）：短回复（"选 2"）的消解依据。
  let previousHuman: string | undefined
  let assistantContext: string | undefined
  for (let index = currentUserIndex - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message) continue
    if (previousHuman === undefined && message.role === 'user') {
      previousHuman = cleanEnvelopeContext(message.content, 400)
    }
    if (assistantContext === undefined && message.role === 'assistant') {
      assistantContext = cleanEnvelopeContext(message.content, 800)
    }
    if (previousHuman !== undefined && assistantContext !== undefined) break
  }

  return {
    prompt: currentPrompt,
    ...(previousHuman !== undefined ? { previousHuman } : {}),
    ...(assistantContext !== undefined ? { assistantContext } : {}),
  }
}

interface DeltaCandidate {
  kind?: unknown
  statement?: unknown
  rejectedAlternative?: unknown
  rationale?: unknown
  source?: unknown
  evidence?: unknown
  friction?: unknown
}

function parseFriction(value: unknown): SharpshooterFriction | undefined {
  if (!value || typeof value !== 'object') return undefined
  const friction = value as Record<string, unknown>
  if (
    typeof friction.corrective !== 'boolean' ||
    typeof friction.regression !== 'boolean' ||
    typeof friction.subtle !== 'boolean'
  ) {
    return undefined
  }
  return {
    corrective: friction.corrective,
    regression: friction.regression,
    subtle: friction.subtle,
  }
}

/**
 * 宿主侧准入：LLM 产出只是候选——statement 非空、evidence 是当前 prompt 的
 * 精确子串、kind/source/friction 形状合法，缺一即丢。通过者文本字段再过
 * redactSecretText（记忆一旦落盘会回注每一个 provider 的提示词，凭证必须在
 * 写入前抹除；evidence 的子串校验在此之前完成，脱敏不影响准入判定）。
 */
export function admitDelta(
  candidate: unknown,
  currentPrompt: string,
  sessionId: string,
  now: number = Date.now(),
): SharpshooterDelta | undefined {
  if (!candidate || typeof candidate !== 'object') {
    logger.debug('extraction rejected non-object delta')
    return undefined
  }
  const raw = candidate as DeltaCandidate
  if (typeof raw.statement !== 'string' || !raw.statement.trim()) {
    logger.debug('extraction rejected delta with empty statement')
    return undefined
  }
  if (typeof raw.evidence !== 'string' || !raw.evidence || !currentPrompt.includes(raw.evidence)) {
    logger.debug('extraction rejected delta with unverifiable evidence')
    return undefined
  }
  if (typeof raw.kind !== 'string' || !Object.hasOwn(SHARPSHOOTER_DELTA_KINDS, raw.kind)) {
    logger.debug('extraction rejected delta with invalid kind')
    return undefined
  }
  if (typeof raw.source !== 'string' || !Object.hasOwn(SHARPSHOOTER_DELTA_SOURCES, raw.source)) {
    logger.debug('extraction rejected delta with invalid source')
    return undefined
  }
  const friction = parseFriction(raw.friction)
  if (!friction) {
    logger.debug('extraction rejected delta with invalid friction')
    return undefined
  }

  return {
    v: 1,
    kind: raw.kind as SharpshooterDeltaKind,
    statement: redactSecretText(raw.statement.trim()),
    ...(typeof raw.rejectedAlternative === 'string' && raw.rejectedAlternative.trim()
      ? { rejectedAlternative: redactSecretText(raw.rejectedAlternative.trim()) }
      : {}),
    ...(typeof raw.rationale === 'string' && raw.rationale.trim()
      ? { rationale: redactSecretText(raw.rationale.trim()) }
      : {}),
    source: raw.source as SharpshooterDeltaSource,
    evidence: redactSecretText(raw.evidence),
    friction,
    sessionId,
    ts: now,
  }
}

/** 提取的输出预算：单条 prompt 的 delta 集合远用不满，2048 足够且便宜。 */
const EXTRACTION_MAX_TOKENS = 2048

/** 执行一次提取：envelope → LLM → 逐条准入 → 入队。返回入队条数。 */
export async function runExtraction(opts: {
  registry: Registry
  config: MemoryLlmConfig
  memoriesRoot: string
  cwd: string
  sessionId: string
  envelope: SharpshooterEnvelope
  /** 依赖注入（测试 fake）；缺省走真实 LLM。 */
  llmCall?: MemoryLlmCall
  /** 每条 delta 入队后的回调（backend 借此失效注入缓存）。 */
  onDelta?: (delta: SharpshooterDelta) => void
  signal?: AbortSignal
}): Promise<number> {
  const llm = opts.llmCall ?? callToolRequired
  const response = await llm({
    registry: opts.registry,
    config: opts.config,
    system: EXTRACT_SYSTEM_PROMPT,
    input: renderExtractInput(opts.envelope),
    tool: RECORD_DELTAS_TOOL,
    maxTokens: EXTRACTION_MAX_TOKENS,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  let admitted = 0
  for (const call of response.toolCalls) {
    if (call.name !== RECORD_DELTAS_TOOL.name) continue
    const args = call.arguments as { deltas?: unknown } | null
    if (!args || typeof args !== 'object' || !Array.isArray(args.deltas)) {
      logger.debug('extraction rejected malformed record_deltas call')
      continue
    }
    for (const candidate of args.deltas) {
      const delta = admitDelta(candidate, opts.envelope.prompt, opts.sessionId)
      if (!delta) continue
      await appendDelta(opts.memoriesRoot, opts.cwd, delta)
      admitted += 1
      opts.onDelta?.(delta)
    }
  }
  return admitted
}
