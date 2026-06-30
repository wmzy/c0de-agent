/**
 * websearch Brave 独立索引后端测试。
 *
 * 来源：oh-my-pi（providers/brave），裁剪适配 c0de-agent。
 */
import { describe, expect, it, vi } from 'vitest'
import { braveProvider, recencyToFreshness } from './brave.js'

function mockFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('braveProvider', () => {
  it('is available only when apiKey is provided', () => {
    expect(braveProvider.isAvailable()).toBe(false)
    expect(braveProvider.isAvailable('brave-key')).toBe(true)
  })

  it('recencyToFreshness maps recency to Brave freshness codes', () => {
    expect(recencyToFreshness('day')).toBe('pd')
    expect(recencyToFreshness('week')).toBe('pw')
    expect(recencyToFreshness('month')).toBe('pm')
    expect(recencyToFreshness('year')).toBe('py')
    expect(recencyToFreshness(undefined)).toBeUndefined()
  })

  it('sends GET with X-Subscription-Token header and count param', async () => {
    const f = mockFetch({ web: { results: [] } })
    await braveProvider.search({ query: 'rust', apiKey: 'brave-key', limit: 5, fetchImpl: f })
    const [url, init] = vi.mocked(f).mock.calls[0] ?? []
    expect(url).toContain('https://api.search.brave.com/res/v1/web/search')
    expect(url).toContain('q=rust')
    expect(url).toContain('count=5')
    expect(init?.method).toBe('GET')
    expect((init?.headers as Record<string, string>)['X-Subscription-Token']).toBe('brave-key')
  })

  it('appends freshness param when recency set', async () => {
    const f = mockFetch({ web: { results: [] } })
    await braveProvider.search({ query: 'q', apiKey: 'k', recency: 'week', fetchImpl: f })
    const url = vi.mocked(f).mock.calls[0]?.[0] as string
    expect(url).toContain('freshness=pw')
  })

  it('omits freshness when recency not set', async () => {
    const f = mockFetch({ web: { results: [] } })
    await braveProvider.search({ query: 'q', apiKey: 'k', fetchImpl: f })
    const url = vi.mocked(f).mock.calls[0]?.[0] as string
    expect(url).not.toContain('freshness')
  })

  it('parses web.results into sources', async () => {
    const f = mockFetch({
      web: {
        results: [
          { title: 'Rust', url: 'https://rust-lang.org', description: 'A language' },
          { title: 'Docs', url: 'https://doc.rust-lang.org', description: 'Book' },
        ],
      },
    })
    const res = await braveProvider.search({ query: 'rust', apiKey: 'k', fetchImpl: f })
    expect(res.provider).toBe('brave')
    expect(res.sources).toEqual([
      { title: 'Rust', url: 'https://rust-lang.org', snippet: 'A language' },
      { title: 'Docs', url: 'https://doc.rust-lang.org', snippet: 'Book' },
    ])
  })

  it('skips results without url, falls back title to url', async () => {
    const f = mockFetch({
      web: {
        results: [{ description: 'no url' }, { url: 'https://t.example', description: 'd' }],
      },
    })
    const res = await braveProvider.search({ query: 'q', apiKey: 'k', fetchImpl: f })
    expect(res.sources).toEqual([
      { title: 'https://t.example', url: 'https://t.example', snippet: 'd' },
    ])
  })

  it('throws with status on non-2xx', async () => {
    const f = mockFetch('unauthorized', 401)
    await expect(braveProvider.search({ query: 'q', apiKey: 'bad', fetchImpl: f })).rejects.toThrow(
      /401/,
    )
  })

  it('handles empty results gracefully', async () => {
    const f = mockFetch({ web: { results: [] } })
    const res = await braveProvider.search({ query: 'q', apiKey: 'k', fetchImpl: f })
    expect(res.sources).toEqual([])
  })
})
