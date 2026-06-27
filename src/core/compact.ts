import type { DB } from '../db/client.js'
import { chatStream } from '../llm/provider.js'
import type { Registry } from '../llm/registry.js'
import { compactSession } from '../session/compaction.js'
import type { CompactionConfig, CompactionResult, Summarizer } from '../session/types.js'
import type { ChatRequest, StreamChunk } from '../shared/types/llm.js'

/** Create a Summarizer backed by an LLM streaming call. */
function createSummarizer(
  registry: Registry,
  provider: string,
  model: string,
  opts?: { maxTokens?: number; signal?: AbortSignal },
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

/** Run compaction on a session using the provided summarizer. */
async function runCompaction(
  db: DB,
  sessionId: string,
  summarizer: Summarizer,
  config?: Partial<CompactionConfig>,
): Promise<CompactionResult> {
  return compactSession(db, sessionId, summarizer, config)
}

export { createSummarizer, runCompaction }
