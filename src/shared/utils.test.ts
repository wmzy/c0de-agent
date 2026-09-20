import { describe, expect, it } from 'vitest'
import { roundTo } from './round.js'
import { generateId, now } from './utils.js'

describe('generateId', () => {
  it('returns a UUID v4 string', () => {
    const id = generateId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('produces unique values on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()))
    expect(ids.size).toBe(100)
  })
})

describe('now', () => {
  it('returns a positive integer (milliseconds since epoch)', () => {
    const ts = now()
    expect(typeof ts).toBe('number')
    expect(Number.isInteger(ts)).toBe(true)
    expect(ts).toBeGreaterThan(0)
  })

  it('returns a value close to Date.now()', () => {
    const before = Date.now()
    const ts = now()
    const after = Date.now()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})

describe('roundTo', () => {
  it('按十进制 half-up 舍入二进制浮点陷阱值', () => {
    expect(roundTo(1.005, 2)).toBe(1.01)
    expect(roundTo(0.015, 2)).toBe(0.02)
    expect(roundTo(2.675, 2)).toBe(2.68)
  })
  it('普通值行为与 toFixed 一致', () => {
    expect(roundTo(1.234, 2)).toBe(1.23)
    expect(roundTo(0.001, 4)).toBe(0.001)
    expect(roundTo(10, 2)).toBe(10)
    expect(roundTo(0, 2)).toBe(0)
  })
  it('负数按绝对值舍入', () => {
    expect(roundTo(-1.005, 2)).toBe(-1.01)
  })
})
