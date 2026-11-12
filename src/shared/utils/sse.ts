// SSE（Server-Sent Events）字节流分帧的单一实现：LLM 流式响应（OpenAI 的
// `data: {...}` 与 Anthropic 的 `event: …\ndata: {...}`）与 MCP streamable HTTP
// （text/event-stream）共用——此前 llm/transport 与 mcp/transport 各持一份且已
// 漂移（MCP 侧逐 data: 行派发，把规范合法的多行 data 事件拆成非法分片）。

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

/**
 * Parse a Server-Sent Events byte stream into individual `data:` payloads,
 * yielding the joined data string of each event block (empty payloads skipped).
 * Semantics:
 *  - streaming TextDecoder decode (multi-byte UTF-8 split across chunks safe);
 *  - CRLF line endings normalized to LF before framing (spec-legal; some
 *    gateways/proxies rewrite them) — otherwise `\r\n\r\n`-separated events
 *    never match `\n\n` and stick in the buffer forever;
 *  - events framed by a blank line; a block's multiple `data:` lines are
 *    joined with '\n' per the SSE spec;
 *  - a trailing event without a final blank line is flushed on stream close
 *    (decoder buffer flushed too, so a tail cut mid-codepoint still decodes);
 *  - the reader is cancelled and its lock released on every exit path (normal
 *    completion, thrown error, or early consumer break) — cancel() rejects on
 *    an already-closed/errored stream, swallowed so it never masks the
 *    original error propagating through the generator.
 */
async function* sseDataPayloads(
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
      buffer = buffer.replace(/\r\n/g, '\n')
      let sepIndex = buffer.indexOf('\n\n')
      while (sepIndex !== -1) {
        const block = buffer.slice(0, sepIndex)
        buffer = buffer.slice(sepIndex + 2)
        const data = extractData(block)
        if (data !== null && data.length > 0) yield data
        sepIndex = buffer.indexOf('\n\n')
      }
    }
    // 流正常关闭：flush decoder 内部缓冲 + 残留尾部事件——最后一个 data: 行
    // 无尾随空行（服务器发完直接关流，SSE 规范允许）时事件仍在缓冲区里，
    // 空行分帧无法覆盖该帧，须显式收尾，否则最后一条消息被静默丢弃。
    buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n')
    const tailData = extractData(buffer)
    if (tailData !== null && tailData.length > 0) yield tailData
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export { sseDataPayloads }
