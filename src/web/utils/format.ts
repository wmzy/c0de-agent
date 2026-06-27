import type { CodeReference } from '../types/index.js'

/** 解析输入文本中的代码引用 @[path:start-end] 或 @[msgId:n]。 */
export function parseCodeReference(text: string): CodeReference | null {
  const rangeMatch = text.match(/^@\[([^:]+):(\d+)-(\d+)\]$/)
  if (rangeMatch) {
    const [, path, start, end] = rangeMatch
    return {
      _tag: 'file',
      path: path ?? '',
      startLine: Number(start),
      endLine: Number(end),
    }
  }
  const singleMatch = text.match(/^@\[([^:]+):(\d+)\]$/)
  if (singleMatch) {
    const [, id, idx] = singleMatch
    if ((id ?? '').includes('.')) {
      return { _tag: 'file', path: id ?? '', startLine: Number(idx), endLine: Number(idx) }
    }
    return { _tag: 'message', messageId: id ?? '', blockIndex: Number(idx) }
  }
  return null
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`
  return `${(n / 1000).toFixed(1)}k`
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
