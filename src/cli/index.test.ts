import { describe, expect, it } from 'vitest'
import { COMMANDS, dispatch } from './index.js'

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
