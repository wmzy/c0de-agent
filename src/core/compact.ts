import { chatStream } from '../llm/provider.js'
import type { Registry } from '../llm/registry.js'
import type { FallbackChain } from '../llm/routing.js'
import type { Summarizer } from '../session/types.js'
import type { ChatRequest, StreamChunk } from '../shared/types/llm.js'

/** Create a Summarizer backed by an LLM streaming call. */
function createSummarizer(
  registry: Registry,
  provider: string,
  model: string,
  opts?: { maxTokens?: number; signal?: AbortSignal; fallback?: FallbackChain },
): Summarizer {
  return async (prompt: string): Promise<string> => {
    const request: ChatRequest = {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      ...(opts?.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    }
    const chunks: StreamChunk[] = []
    for await (const chunk of chatStream({ registry, signal: opts?.signal }, request, {
      provider,
      model,
      ...(opts?.fallback ? { fallback: opts.fallback } : {}),
    })) {
      if (chunk._tag === 'text') {
        chunks.push(chunk)
      }
      if (chunk._tag === 'error') {
        throw new Error(chunk.error.message)
      }
    }
    return chunks.map((c) => (c._tag === 'text' ? c.text : '')).join('')
  }
}

export { createSummarizer }
