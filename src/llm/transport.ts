import { isContextOverflow } from './provider-error.js'
import { llmError } from './schema/errors.js'

/**
 * Parse a Server-Sent Events byte stream into individual `data:` payloads.
 * Emits the decoded data string for each event block. Skips empty data and
 * the `[DONE]` sentinel. Works for both OpenAI (`data: {...}`) and Anthropic
 * (`event: {type}\ndata: {...}`) framing — only the `data:` lines are emitted.
 */
const sseFraming = async function* (
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sepIndex: number
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sepIndex)
        buffer = buffer.slice(sepIndex + 2)
        const data = extractData(block)
        if (data !== null && data.length > 0 && data !== '[DONE]') {
          yield data
        }
      }
    }
    const tailData = extractData(buffer)
    if (tailData !== null && tailData.length > 0 && tailData !== '[DONE]') {
      yield tailData
    }
  } finally {
    reader.releaseLock()
  }
}

/** Join all `data:` lines of an SSE block into one string. */
const extractData = (block: string): string | null => {
  const lines = block.split('\n')
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  return dataLines.join('\n')
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
 * POST a JSON body and yield SSE data frames from the response.
 * Throws an LLMError on non-2xx responses, classifying context-overflow.
 */
const streamHTTP = async function* (
  options: StreamHTTPOptions,
): AsyncGenerator<string, void, unknown> {
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

  yield* sseFraming(response.body)
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
    const retryAfterMs = parseRetryAfterMs(
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
  if (status >= 500) {
    return llmError('ProviderShared', 'request', {
      _tag: 'ProviderInternal',
      message: body || `Provider error (${status})`,
      status,
      http,
    })
  }
  if (isContextOverflow(body)) {
    return llmError('ProviderShared', 'request', {
      _tag: 'InvalidRequest',
      message: body || 'Context overflow',
      classification: 'context-overflow',
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

const parseRetryAfterMs = (
  retryAfterMs?: string | null,
  retryAfter?: string | null,
): number | undefined => {
  if (retryAfterMs !== null && retryAfterMs !== undefined) {
    const parsed = Number.parseFloat(retryAfterMs)
    if (!Number.isNaN(parsed)) return Math.ceil(parsed)
  }
  if (retryAfter !== null && retryAfter !== undefined) {
    const parsed = Number.parseFloat(retryAfter)
    if (!Number.isNaN(parsed)) return Math.ceil(parsed * 1000)
  }
  return undefined
}

export { classifyHttpError, sseFraming, streamHTTP }
export type { StreamHTTPOptions }
