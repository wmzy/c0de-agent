import { describe, expect, it } from 'vitest'
import { DEFAULT_TRUNCATE_OPTIONS, truncateOutput } from './truncate.js'

describe('truncateOutput', () => {
  it('returns short output unchanged', () => {
    const result = truncateOutput('hello\nworld')
    expect(result.truncated).toBe(false)
    expect(result.output).toBe('hello\nworld')
    expect(result.totalLines).toBe(2)
    expect(result.totalChars).toBe(11)
  })

  it('truncates by maxLines keeping head and tail', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const result = truncateOutput(lines.join('\n'), {
      ...DEFAULT_TRUNCATE_OPTIONS,
      maxLines: 30,
      headLines: 10,
      tailLines: 10,
    })
    expect(result.truncated).toBe(true)
    expect(result.totalLines).toBe(100)
    // head 10 + marker line + tail 10 = 21 lines
    const outLines = result.output.split('\n')
    expect(outLines.length).toBe(21)
    expect(outLines[0]).toBe('line 0')
    expect(outLines[9]).toBe('line 9')
    expect(outLines[10]).toContain('truncated')
    expect(outLines[11]).toBe('line 90')
    expect(outLines[20]).toBe('line 99')
  })

  it('truncates by maxChars', () => {
    const long = 'x'.repeat(500)
    const result = truncateOutput(long, {
      ...DEFAULT_TRUNCATE_OPTIONS,
      maxLines: 10000,
      maxChars: 100,
      headLines: 30,
      tailLines: 30,
    })
    expect(result.truncated).toBe(true)
    expect(result.output.length).toBeLessThan(long.length)
    expect(result.output).toContain('truncated')
  })

  it('does not truncate when under all limits', () => {
    const result = truncateOutput('short', {
      maxLines: 100,
      maxChars: 1000,
      headLines: 10,
      tailLines: 10,
    })
    expect(result.truncated).toBe(false)
    expect(result.output).toBe('short')
  })

  it('handles empty output', () => {
    const result = truncateOutput('')
    expect(result.truncated).toBe(false)
    expect(result.output).toBe('')
    expect(result.totalLines).toBe(0)
    expect(result.totalChars).toBe(0)
  })

  it('head-only truncation when tail exceeds available lines', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `line ${i}`)
    const result = truncateOutput(lines.join('\n'), {
      maxLines: 5,
      maxChars: 10000,
      headLines: 5,
      tailLines: 10,
    })
    // 15 lines, head 5, but tail 10 would overlap → just keep first 5
    expect(result.truncated).toBe(true)
    const outLines = result.output.split('\n')
    expect(outLines.length).toBeLessThanOrEqual(6)
  })

  it('counts lines correctly for string without trailing newline', () => {
    const result = truncateOutput('a\nb\nc')
    expect(result.totalLines).toBe(3)
  })
})
