import { estimateTokens } from '../session/token.js'
import type { TokenBudget } from '../shared/types/agent.js'
import type { Message } from '../shared/types/message.js'
import type { CompactionConfig } from './config.js'

const SYSTEM_PROMPT_RATIO = 0.2
const KEEP_RECENT_RATIO = 0.1

function createTokenBudget(
  totalTokens: number,
  opts?: { reserved?: number; keepRecent?: number },
): TokenBudget {
  const reserved = opts?.reserved ?? Math.floor(totalTokens * SYSTEM_PROMPT_RATIO)
  return {
    total: totalTokens,
    reserved,
    available: totalTokens - reserved,
    used: 0,
    keepRecent: opts?.keepRecent ?? Math.floor(totalTokens * KEEP_RECENT_RATIO),
  }
}

function estimateBudget(messages: Message[]): number {
  return messages.reduce((sum, m) => {
    if (m.tokenCount > 0) return sum + m.tokenCount
    const text = m.content
      .map((p) => (p._tag === 'text' || p._tag === 'thinking' ? p.text : ''))
      .join('')
    return sum + estimateTokens(text)
  }, 0)
}

function fitToBudget(messages: Message[], budget: TokenBudget): Message[] {
  if (messages.length === 0) return []

  let recentTokens = 0
  let recentStart = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const tc =
      m.tokenCount > 0
        ? m.tokenCount
        : estimateTokens(
            m.content
              .map((p) => (p._tag === 'text' || p._tag === 'thinking' ? p.text : ''))
              .join(''),
          )
    if (recentTokens + tc > budget.keepRecent) break
    recentTokens += tc
    recentStart = i
  }
  // Always keep at least the last message
  recentStart = Math.min(recentStart, messages.length - 1)

  const result: Message[] = []
  let used = 0
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue
    const tc =
      m.tokenCount > 0
        ? m.tokenCount
        : estimateTokens(
            m.content
              .map((p) => (p._tag === 'text' || p._tag === 'thinking' ? p.text : ''))
              .join(''),
          )
    const mustKeep = i >= recentStart
    if (mustKeep || used + tc <= budget.available) {
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

export { createTokenBudget, estimateBudget, fitToBudget, shouldCompact }
