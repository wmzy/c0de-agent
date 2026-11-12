import { sseDataPayloads } from '../shared/utils/sse.js'
import { isContextOverflow } from './provider-error.js'
import { parseRetryAfterHeaders } from './retry.js'
import { llmError } from './schema/errors.js'

/**
 * Parse a Server-Sent Events byte stream into individual `data:` payloads.
 * Emits the decoded data string for each event block. Skips empty data and
 * the `[DONE]` sentinel. Works for both OpenAI (`data: {...}`) and Anthropic
 * (`event: {type}\ndata: {...}`) framing — only the `data:` lines are emitted.
 *
 * 分帧本体见 shared/utils/sse.ts（与 MCP streamable HTTP 的 SSE 解析共用）；
 * 此处仅保留 LLM 侧过滤：`[DONE]` 哨兵（空 payload 已由分帧器跳过）。
 */
const sseFraming = async function* (
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  for await (const data of sseDataPayloads(stream)) {
    if (data !== '[DONE]') yield data
  }
}

type StreamHTTPOptions = {
  url: string
  body: unknown
  headers: Record<string, string>
  signal?: AbortSignal
  /** Injectable fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Eagerly POST a JSON body and return the response body stream for framing.
 * Throws an LLMError (classified) on non-2xx responses or transport failure.
 * Used when the connection must be retryable independently of frame consumption.
 */
const httpPost = async (options: StreamHTTPOptions): Promise<ReadableStream<Uint8Array>> => {
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      signal: options.signal,
    })
  } catch (cause) {
    throw llmError('ProviderShared', 'request', {
      _tag: 'Transport',
      message: `Failed to send request to ${options.url}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      kind: 'network',
      url: options.url,
    })
  }
  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => '')
    throw classifyHttpError(response.status, text, options.url, response.headers)
  }
  return response.body
}

/** Map an HTTP failure status + body to an LLMError. */
const classifyHttpError = (
  status: number,
  body: string,
  url: string,
  headers: Headers,
): ReturnType<typeof llmError> => {
  const http = {
    request: { method: 'POST', url, headers: {} },
    response: { status, headers: Object.fromEntries(headers.entries()) },
    body,
  }
  if (status === 401 || status === 403) {
    return llmError('ProviderShared', 'request', {
      _tag: 'Authentication',
      message: body || `Authentication failed (${status})`,
      kind: status === 401 ? 'invalid' : 'insufficient-permissions',
      http,
    })
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfterHeaders(
      headers.get('retry-after-ms'),
      headers.get('retry-after'),
    )
    return llmError('ProviderShared', 'request', {
      _tag: 'RateLimit',
      message: body || 'Rate limited',
      retryAfterMs,
      http,
    })
  }
  if (status === 402 || /quota|billing|insufficient.{0,4}quota|exceeded.{0,12}limit/i.test(body)) {
    return llmError('ProviderShared', 'request', {
      _tag: 'QuotaExceeded',
      message: body || `Quota exceeded (${status})`,
      http,
    })
  }
  if (status >= 500) {
    return llmError('ProviderShared', 'request', {
      _tag: 'ProviderInternal',
      message: body || `Provider error (${status})`,
      status,
      http,
    })
  }
  // Bodyless 413/400 (no error text) is a context-window overflow signal.
  if (status === 413 || (status === 400 && body.length === 0) || isContextOverflow(body)) {
    return llmError('ProviderShared', 'request', {
      _tag: 'InvalidRequest',
      message: body || 'Context overflow',
      classification: 'context-overflow',
      http,
    })
  }
  if (/content.{0,4}(filter|policy)|safety/i.test(body)) {
    return llmError('ProviderShared', 'request', {
      _tag: 'ContentPolicy',
      message: body || 'Content policy violation',
      http,
    })
  }
  return llmError('ProviderShared', 'request', {
    _tag: 'UnknownProvider',
    message: body || `Unknown provider error (${status})`,
    status,
    http,
  })
}

export type { StreamHTTPOptions }
export { classifyHttpError, httpPost, sseFraming }
