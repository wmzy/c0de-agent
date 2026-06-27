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

  // Char-based truncation (keep proportional head/tail of chars)
  const keepChars = opts.maxChars
  const headChars = Math.floor(keepChars * 0.5)
  const tailChars = keepChars - headChars
  const head = output.slice(0, headChars)
  const tail = output.slice(totalChars - tailChars)
  const omitted = totalChars - keepChars
  const marker = `\n[... ${omitted} chars truncated ...]\n`
  return { output: head + marker + tail, truncated: true, totalLines, totalChars }
}
