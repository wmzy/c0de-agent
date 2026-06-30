import { describe, expect, it } from 'vitest'
import { normalizePaste, pasteMode } from './paste.js'

describe('normalizePaste', () => {
  it('CRLF 规范化为 LF', () => {
    expect(normalizePaste('a\r\nb')).toBe('a\nb')
  })
  it('CR 规范化为 LF', () => {
    expect(normalizePaste('a\rb')).toBe('a\nb')
  })
  it('无 CR 原样返回', () => {
    expect(normalizePaste('a\nb')).toBe('a\nb')
  })
})

describe('pasteMode', () => {
  it('单行无换行 → native', () => {
    expect(pasteMode('just text')).toBe('native')
  })
  it('含换行但未达阈值 → manual', () => {
    expect(pasteMode('line1\nline2')).toBe('manual')
  })
  it('≥8000 字符 → manual', () => {
    expect(pasteMode('a'.repeat(8000))).toBe('manual')
  })
  it('7999 字符 → native（单行）', () => {
    expect(pasteMode('a'.repeat(7999))).toBe('native')
  })
  it('≥120 行 → manual', () => {
    const text = Array.from({ length: 120 }, () => 'x').join('\n')
    expect(pasteMode(text)).toBe('manual')
  })
  it('119 行 → manual（仍含换行）', () => {
    const text = Array.from({ length: 119 }, () => 'x').join('\n')
    expect(pasteMode(text)).toBe('manual')
  })
})
