import type { LLMErrorReason } from './schema/errors.js'
import { isLLMError } from './schema/errors.js'

const patterns: RegExp[] = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
]

/** True when a provider error message indicates the input exceeded the context window. */
const isContextOverflow = (message: string): boolean =>
  patterns.some((pattern) => pattern.test(message)) ||
  /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)

/** True when a thrown/produced value represents a context-overflow failure. */
const isContextOverflowFailure = (failure: unknown): boolean => {
  if (!isLLMError(failure)) return false
  const reason: LLMErrorReason = failure.reason
  return reason._tag === 'InvalidRequest' && reason.classification === 'context-overflow'
}

export { isContextOverflow, isContextOverflowFailure }
