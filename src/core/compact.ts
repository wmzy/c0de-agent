import { chatStream } from '../llm/provider.js'
import type { Registry } from '../llm/registry.js'
import { buildFallbackChain, type FallbackChain } from '../llm/routing.js'
import type { Summarizer } from '../session/types.js'
import type { ChatRequest, StreamChunk } from '../shared/types/llm.js'
import type { Config } from './config.js'

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

/**
 * createSummarizer + buildFallbackChain 组合构造单点：按 config.fallback 解析
 * 回退链并注入摘要器（链未启用/无候选时省略 fallback 字段，与此前各调用点的
 * 条件展开语义一致）。此前 server/routes/files.ts（git-commit 默认模式，多
 * maxTokens 限制）与 session.ts（POST /:id/compact）各持一份手写骨架；opts
 * 透传 maxTokens/signal。loop/compaction.ts 的变体不迁入：其 provider/model
 * 取自 run state、signal 取自 state.abortController，入参形状不同。
 */
function createSummarizerWithFallback(
  registry: Registry,
  config: Pick<Config, 'providers' | 'fallback'>,
  provider: string,
  model: string,
  opts?: { maxTokens?: number; signal?: AbortSignal },
): Summarizer {
  const fallback = buildFallbackChain(config, provider, model)
  return createSummarizer(registry, provider, model, {
    ...(opts ?? {}),
    ...(fallback ? { fallback } : {}),
  })
}

export { createSummarizer, createSummarizerWithFallback }
