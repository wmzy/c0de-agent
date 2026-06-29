import { describe, expect, it } from 'vitest'
import type { URLResolveContext } from '../shared/types/tool.js'
import {
  createURLRegistry,
  isURLPath,
  parseScheme,
  registerURLResolver,
  resolveURL,
} from './resolver.js'

const ctx: URLResolveContext = { cwd: '/tmp', session: { id: 's1', cwd: '/tmp' } }

describe('URL resolver registry', () => {
  it('createURLRegistry yields an empty registry', async () => {
    const reg = createURLRegistry()
    expect(await resolveURLIsError(reg, 'skill://x', ctx)).toBe(true)
  })

  it('registerURLResolver + resolveURL returns resolved content', async () => {
    const reg = createURLRegistry()
    registerURLResolver(reg, {
      scheme: 'skill',
      resolve: async (url) => `SKILL[${url}]`,
    })
    const res = await resolveURL(reg, 'skill://brainstorming', ctx)
    expect(res._tag).toBe('ok')
    if (res._tag === 'ok') expect(res.content).toBe('SKILL[skill://brainstorming]')
  })

  it('resolveURL returns error for unregistered scheme', async () => {
    const reg = createURLRegistry()
    registerURLResolver(reg, { scheme: 'skill', resolve: async () => 'x' })
    const res = await resolveURL(reg, 'agent://Foo', ctx)
    expect(res._tag).toBe('error')
  })

  it('first registered resolver for a scheme wins', async () => {
    const reg = createURLRegistry()
    registerURLResolver(reg, { scheme: 'x', resolve: async () => 'first' })
    registerURLResolver(reg, { scheme: 'x', resolve: async () => 'second' })
    const res = await resolveURL(reg, 'x://y', ctx)
    expect(res._tag).toBe('ok')
    if (res._tag === 'ok') expect(res.content).toBe('first')
  })

  it('resolver receives the full url and ctx', async () => {
    const reg = createURLRegistry()
    let seenUrl = ''
    let seenCwd = ''
    registerURLResolver(reg, {
      scheme: 'agent',
      resolve: async (url, c) => {
        seenUrl = url
        seenCwd = c.cwd
        return 'ok'
      },
    })
    await resolveURL(reg, 'agent://Task1', ctx)
    expect(seenUrl).toBe('agent://Task1')
    expect(seenCwd).toBe('/tmp')
  })
})

describe('URL path detection', () => {
  it('isURLPath identifies scheme:// paths', () => {
    expect(isURLPath('skill://brainstorming')).toBe(true)
    expect(isURLPath('agent://Task1')).toBe(true)
    expect(isURLPath('pr://123')).toBe(true)
  })

  it('isURLPath returns false for plain file paths', () => {
    expect(isURLPath('src/main.ts')).toBe(false)
    expect(isURLPath('./relative.ts')).toBe(false)
    expect(isURLPath('/abs/path.ts')).toBe(false)
    expect(isURLPath('')).toBe(false)
  })

  it('parseScheme extracts the scheme prefix', () => {
    expect(parseScheme('skill://brainstorming')).toBe('skill')
    expect(parseScheme('agent://Task1')).toBe('agent')
  })

  it('parseScheme returns null for plain paths', () => {
    expect(parseScheme('src/main.ts')).toBeNull()
    expect(parseScheme('/abs/path.ts')).toBeNull()
  })
})

// helper
async function resolveURLIsError(
  reg: ReturnType<typeof createURLRegistry>,
  url: string,
  c: URLResolveContext,
): Promise<boolean> {
  const res = await resolveURL(reg, url, c)
  return res._tag === 'error'
}
