import { describe, it, expect } from 'vitest'
import { generateId, now } from './utils.js'

describe('generateId', () => {
  it('returns a UUID v4 string', () => {
    const id = generateId()
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
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
