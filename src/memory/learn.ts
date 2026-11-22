// learn 工具与 learned.md 存储：sharpshooter 自动提取之外的手动记忆通道。
//
// learned.md 进 loadContext 注入（与三个决策文件共享 injectionTokenLimit 预算），
// 因此与决策文件同目录（bank 内）、同锁纪律（CLI 与 server 并发写用 learn.lock）。
// 注入面即攻击面：写入前 neutralizeInjection（剥 <>/反引号/~~/控制字符——
// 阻断把 markdown 语法或提示词标记 smuggling 进系统提示）+ redactSecretText，
// 读取时再洗一遍（防手工编辑绕过写侧清洗）。

import * as fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { getLogger } from '../core/logger.js'
import type { ToolDef } from '../shared/types/tool.js'
import { redactSecretText } from '../shared/utils/secret-redact.js'
import { errorMessage, headChars } from '../shared/utils/string.js'
import type { SharpshooterBackend } from './backend.js'
import { acquireBankLock, memoryFilePath } from './storage.js'

const logger = getLogger('memory.learn')

export const LEARNED_FILE = 'learned.md'

/** learned.md 条目上限。 */
export const LEARNED_MAX_ENTRIES = 100
/** 单条 memory 上限（字符）。 */
export const LEARNED_MEMORY_LIMIT = 2000
/** 单条 context 上限（字符）。 */
export const LEARNED_CONTEXT_LIMIT = 400

/** C0 控制字符（除 \t=0x09）+ DEL 的字符类（按码点区间书写，压成空格）。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 刻意剔除 C0/DEL 控制字符，保证 learned 条目单行不变式
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g

/** 注入净化：剥 markdown/提示词标记（尖括号/反引号/波浪线）与控制字符，
 *  空白压平为单空格（条目单行不变式——learned.md 按行解析）。 */
export function neutralizeInjection(text: string): string {
  return (
    text
      .replace(/[<>`~]/g, '')
      // 控制字符直接换成空格（\n 也在其中，保证单行不变式）。
      .replace(CONTROL_CHARS, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** 去重键：小写 + 只留字母数字（含 CJK），大小写/标点/空白差异视为同义。 */
export function normalizeLearnedKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

export interface LearnedEntry {
  memory: string
  context?: string
}

/**
 * 解析 learned.md：`- memory` 起条目，紧跟的 `  - context` 缩进行是其上下文。
 * 解析器对任何手工编辑宽容——不认识的行直接跳过，绝不抛错。
 */
export function parseLearned(content: string): LearnedEntry[] {
  const entries: LearnedEntry[] = []
  let current: LearnedEntry | null = null
  for (const line of content.split('\n')) {
    if (line.startsWith('- ')) {
      current = { memory: line.slice(2).trim() }
      entries.push(current)
    } else if (current && line.startsWith('  - ')) {
      current.context = line.slice(4).trim()
    }
  }
  return entries.filter((entry) => entry.memory.length > 0)
}

/** 渲染 learned.md：newest-first，每条一/两行。 */
export function renderLearned(entries: readonly LearnedEntry[]): string {
  return entries
    .map((entry) =>
      entry.context ? `- ${entry.memory}\n  - ${entry.context}` : `- ${entry.memory}`,
    )
    .join('\n')
}

/** 纯合并逻辑：清洗+截断新条目 → 同义去重（旧的移除）→ 头插 → 截到上限。
 *  返回 added=false 表示清洗后为空（拒绝写入空记忆）。 */
export function mergeLearned(
  entries: readonly LearnedEntry[],
  memory: string,
  context?: string,
  opts: { maxEntries?: number; memoryLimit?: number; contextLimit?: number } = {},
): { entries: LearnedEntry[]; added: boolean } {
  const maxEntries = opts.maxEntries ?? LEARNED_MAX_ENTRIES
  const memoryLimit = opts.memoryLimit ?? LEARNED_MEMORY_LIMIT
  const contextLimit = opts.contextLimit ?? LEARNED_CONTEXT_LIMIT

  const cleanedMemory = neutralizeInjection(memory)
  if (!cleanedMemory) return { entries: [...entries], added: false }
  const entry: LearnedEntry = {
    memory: truncateWithEllipsis(cleanedMemory, memoryLimit),
  }
  const cleanedContext = context !== undefined ? neutralizeInjection(context) : ''
  if (cleanedContext) entry.context = truncateWithEllipsis(cleanedContext, contextLimit)

  const key = normalizeLearnedKey(entry.memory)
  // 同义重投：新条目没带 context 而旧条目有 → 继承旧 context（去重不丢信息）。
  const twin = entries.find((existing) => normalizeLearnedKey(existing.memory) === key)
  if (twin?.context !== undefined && entry.context === undefined) entry.context = twin.context
  const kept = entries.filter((existing) => normalizeLearnedKey(existing.memory) !== key)
  return { entries: [entry, ...kept].slice(0, maxEntries), added: true }
}

/** 截断到 limit 内 + 省略号：共享 truncateHead 的本地薄壳变体——切头先
 *  trimEnd（learned 条目单行不变式下不让尾随空白挤在省略号前）；切片经
 *  headChars 内收，不拆代理对。 */
function truncateWithEllipsis(text: string, limit: number): string {
  return text.length <= limit ? text : `${headChars(text, Math.max(0, limit - 1)).trimEnd()}…`
}

/** 读取 learned.md 并在读取侧再洗一遍（neutralize + redact）。 */
export function readLearned(memoriesRoot: string, cwd: string): Promise<LearnedEntry[]> {
  return fs
    .readFile(memoryFilePath(memoriesRoot, cwd, LEARNED_FILE), 'utf-8')
    .catch(() => '')
    .then((content) =>
      parseLearned(content).map((entry) => ({
        memory: redactSecretText(neutralizeInjection(entry.memory)),
        ...(entry.context !== undefined
          ? { context: redactSecretText(neutralizeInjection(entry.context)) }
          : {}),
      })),
    )
}

/** 追加一条 learned 条目（learn.lock 内读-合并-写）。返回条目总数。 */
export async function appendLearned(
  memoriesRoot: string,
  cwd: string,
  memory: string,
  context?: string,
): Promise<{ added: boolean; total: number }> {
  const lock = await acquireBankLock(memoriesRoot, cwd, 'learn')
  if (!lock) throw new Error('learned memory is being written elsewhere; retry shortly')
  try {
    const existing = parseLearned(
      await fs.readFile(memoryFilePath(memoriesRoot, cwd, LEARNED_FILE), 'utf-8').catch(() => ''),
    )
    const merged = mergeLearned(existing, memory, context)
    if (!merged.added) return { added: false, total: existing.length }
    // 落盘前再过 redactSecretText：learned 内容直接进系统提示，凭证绝不入库。
    const onDisk = merged.entries.map((entry) => ({
      memory: redactSecretText(entry.memory),
      ...(entry.context !== undefined ? { context: redactSecretText(entry.context) } : {}),
    }))
    const file = memoryFilePath(memoriesRoot, cwd, LEARNED_FILE)
    await fs.mkdir(dirname(file), { recursive: true })
    await fs.writeFile(file, `${renderLearned(onDisk)}\n`, 'utf-8')
    return { added: true, total: onDisk.length }
  } finally {
    await lock.release()
  }
}

/** learn 工具：手动记录跨会话应保留的用户决策/偏好/教训（permission ask——
 *  写共享记忆文件，不自动放行）。 */
export function createLearnTool(backend: SharpshooterBackend): ToolDef {
  return {
    name: 'learn',
    description:
      'Record a durable project decision, preference, constraint, or lesson the user taught you, so future sessions remember it. Use ONLY for things the user explicitly stated or accepted — never for task state or speculation. Keep memory to one timeless normative sentence; put the reason in context.',
    parameters: {
      type: 'object',
      properties: {
        memory: {
          type: 'string',
          description:
            'One timeless normative sentence the user decided (no paths, no task state).',
        },
        context: {
          type: 'string',
          description: 'Optional short "because/when" clause for the decision.',
        },
      },
      required: ['memory'],
    },
    permission: 'ask',
    execute: async (input: unknown, ctx) => {
      const { memory, context } = (input ?? {}) as { memory?: unknown; context?: unknown }
      if (typeof memory !== 'string' || !memory.trim()) {
        return { _tag: 'error', error: 'learn requires a non-empty "memory" string' }
      }
      const contextText = typeof context === 'string' && context.trim() ? context : undefined
      try {
        const result = await backend.learn(ctx.cwd, memory, contextText)
        if (!result.added) {
          return { _tag: 'error', error: 'memory was empty after sanitization; nothing recorded' }
        }
        return {
          _tag: 'success',
          output: `Recorded. learned memory now holds ${result.total} entries.`,
        }
      } catch (error) {
        const message = errorMessage(error)
        logger.warn(`learn tool failed: ${message}`)
        return { _tag: 'error', error: message }
      }
    },
  }
}
