import { describe, expect, it } from 'vitest'
import { COMMANDS, dispatch, parseBudgetActionOption } from './index.js'

describe('COMMANDS registry', () => {
  it('includes all builtin commands', () => {
    const names = COMMANDS.map((c) => c.name)
    expect(names).toEqual(
      expect.arrayContaining(['chat', 'serve', 'init', 'config', 'plugin', 'acp']),
    )
  })
})

describe('dispatch', () => {
  it('routes to serve when no args', async () => {
    let served = false
    await dispatch([], {
      runServe: async () => {
        served = true
      },
    })
    expect(served).toBe(true)
  })

  it('throws on unknown command', async () => {
    await expect(dispatch(['bogus'], {})).rejects.toThrow(/unknown command/i)
  })
})

describe('parseBudgetActionOption', () => {
  it('maps warn/abort/pause and undefined', () => {
    expect(parseBudgetActionOption('warn')).toBe('warn')
    expect(parseBudgetActionOption('abort')).toBe('abort')
    expect(parseBudgetActionOption('pause')).toBe('abort') // config 词汇兼容映射
    expect(parseBudgetActionOption(undefined)).toBeUndefined()
  })

  it('rejects unknown values with actionable error', () => {
    expect(() => parseBudgetActionOption('nope')).toThrow(/warn\|abort/)
  })
})
