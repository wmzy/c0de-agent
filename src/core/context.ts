import { estimateTokens } from '../session/token.js'
import type { TokenBudget } from '../shared/types/agent.js'
import type { Message } from '../shared/types/message.js'
import type { CompactionConfig } from './config.js'

// Token 预算分配（spec §3.6 策略1）：
//   reserved       20% — system prompt + 工具描述
//   historyBudget  60% — 历史消息上限
//   当前轮次       20% — available - historyBudget，预留给本轮用户输入与模型输出
const SYSTEM_PROMPT_RATIO = 0.2
const HISTORY_RATIO = 0.6
const KEEP_RECENT_RATIO = 0.1

// calibrateEstimate 的指数移动平均参数与边界。
const CALIBRATION_ALPHA = 0.3
const CALIBRATION_MIN = 0.25
const CALIBRATION_MAX = 4

function createTokenBudget(
  totalTokens: number,
  opts?: { reserved?: number; historyBudget?: number; keepRecent?: number },
): TokenBudget {
  const reserved = opts?.reserved ?? Math.floor(totalTokens * SYSTEM_PROMPT_RATIO)
  return {
    total: totalTokens,
    reserved,
    available: totalTokens - reserved,
    historyBudget: opts?.historyBudget ?? Math.floor(totalTokens * HISTORY_RATIO),
    used: 0,
    keepRecent: opts?.keepRecent ?? Math.floor(totalTokens * KEEP_RECENT_RATIO),
  }
}

/** 单条消息的原始 token 估算（不应用校准系数）。 */
function rawMessageTokens(m: Message): number {
  if (m.tokenCount > 0) return m.tokenCount
  return estimateTokens(
    m.content.map((p) => (p._tag === 'text' || p._tag === 'thinking' ? p.text : '')).join(''),
  )
}

function estimateBudget(messages: Message[], factor = 1.0): number {
  const raw = messages.reduce((sum, m) => sum + rawMessageTokens(m), 0)
  return factor === 1.0 ? raw : Math.round(raw * factor)
}

function fitToBudget(messages: Message[], budget: TokenBudget, factor = 1.0): Message[] {
  if (messages.length === 0) return []

  let recentTokens = 0
  let recentStart = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const tc = rawMessageTokens(m) * factor
    if (recentTokens + tc > budget.keepRecent) break
    recentTokens += tc
    recentStart = i
  }
  // Always keep at least the last message
  recentStart = Math.min(recentStart, messages.length - 1)

  const result: Message[] = []
  let used = 0
  // 历史消息最多占用 historyBudget，超出部分预留给当前轮次（spec §3.6 策略1）。
  const historyCap = budget.historyBudget
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue
    const tc = rawMessageTokens(m) * factor
    const mustKeep = i >= recentStart
    if (mustKeep || used + tc <= historyCap) {
      result.push(m)
      used += tc
    }
  }
  return result
}

function shouldCompact(
  _messages: Message[],
  budget: TokenBudget,
  config: CompactionConfig,
): boolean {
  if (!config.enabled) return false
  if (budget.available <= 0) return false
  const ratio = budget.used / budget.available
  return ratio >= config.threshold
}

/**
 * 按真实 LLM input token 校准估算系数（指数移动平均）。
 *
 * `estimated` 与 `actual` 必须是同一口径——即「system prompt + 工具描述 + 历史消息」
 * 全部 input 的 token 总和。这样 observed = actual/estimated 收敛到 estimateTokens
 * 的系统性系数，可反哺 estimateBudget/fitToBudget 的裁剪与压缩判断。
 *
 * 极端值（首轮流式 chunk 异常等）被 clamp 到 [CALIBRATION_MIN, CALIBRATION_MAX]，
 * 避免单次噪声污染系数。
 */
function calibrateEstimate(prevFactor: number, estimated: number, actual: number): number {
  if (estimated <= 0 || actual <= 0) return prevFactor
  const observed = actual / estimated
  const clamped = Math.min(Math.max(observed, CALIBRATION_MIN), CALIBRATION_MAX)
  return prevFactor * (1 - CALIBRATION_ALPHA) + clamped * CALIBRATION_ALPHA
}

export { calibrateEstimate, createTokenBudget, estimateBudget, fitToBudget, shouldCompact }
