/**
 * Heuristic token estimate: ~4 characters per token for English/code text.
 * This mirrors the common "chars / 4" approximation used by tiktoken's
 * rough estimate mode. A real BPE tokenizer can be plugged in later without
 * changing this signature.
 */
const TOKEN_CHARS_RATIO = 4

const estimateTokens = (text: string): number => {
  if (text.length === 0) return 0
  return Math.ceil(text.length / TOKEN_CHARS_RATIO)
}

export { estimateTokens }
