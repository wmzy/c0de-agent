import type { TruncateOptions, TruncateResult } from './types.js'

/** Default truncation thresholds — tuned for LLM context windows. */
export const DEFAULT_TRUNCATE_OPTIONS: TruncateOptions = {
  maxLines: 2000,
  maxChars: 100_000,
  headLines: 50,
  tailLines: 50,
}

/**
 * Truncate output to fit within line and character limits.
 * Preserves head and tail, inserting a marker for omitted content.
 */
export function truncateOutput(
  output: string,
  opts: TruncateOptions = DEFAULT_TRUNCATE_OPTIONS,
): TruncateResult {
  if (output === '') {
    return { output: '', truncated: false, totalLines: 0, totalChars: 0 }
  }

  const lines = output.split('\n')
  const totalLines = lines.length
  const totalChars = output.length

  // Check if truncation is needed
  const needsLineTrunc = totalLines > opts.maxLines
  const needsCharTrunc = totalChars > opts.maxChars

  if (!needsLineTrunc && !needsCharTrunc) {
    return { output, truncated: false, totalLines, totalChars }
  }

  // Line-based truncation takes priority
  if (needsLineTrunc) {
    const head = lines.slice(0, opts.headLines)
    const tailStart = totalLines - opts.tailLines
    // If tail would overlap head, show only head + marker
    if (tailStart <= opts.headLines) {
      const omitted = totalLines - head.length
      const marker = `[... ${omitted} lines truncated ...]`
      return { output: [...head, marker].join('\n'), truncated: true, totalLines, totalChars }
    }
    const tail = lines.slice(tailStart)
    const omitted = totalLines - head.length - tail.length
    const marker = `[... ${omitted} lines truncated ...]`
    const result = [...head, marker, ...tail].join('\n')
    return { output: result, truncated: true, totalLines, totalChars }
  }

  // Char-based truncation (keep proportional head/tail of chars).
  // 标记长度计入预算：此前 head+tail 吃满 maxChars 后追加标记，输出反而
  // 比原文更长且突破上限（如 100_001 字符 → 100_029 字符）。
  const markerFor = (omitted: number): string => `\n[... ${omitted} chars truncated ...]\n`
  let marker = ''
  let keepChars = opts.maxChars
  for (;;) {
    const omitted = totalChars - keepChars
    const next = markerFor(omitted)
    if (next === marker) break // 数字位数不再变化，收敛
    marker = next
    keepChars = Math.max(0, opts.maxChars - marker.length)
  }
  const headChars = Math.floor(keepChars / 2)
  const tailChars = keepChars - headChars
  const head = output.slice(0, headChars)
  const tail = output.slice(totalChars - tailChars)
  return { output: head + marker + tail, truncated: true, totalLines, totalChars }
}
