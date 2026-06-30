/**
 * websearch DuckDuckGo Instant Answer 后端测试。
 *
 * 来源：oh-my-pi（providers/duckduckgo），裁剪适配 c0de-agent（data+functions，非 class）。
 */
import { describe, expect, it, vi } from 'vitest'
import { duckduckgoProvider } from './duckduckgo.js'

/** 构造一个返回指定 JSON body 的 mock fetch。 */
function mockFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('duckduckgoProvider', () => {
  it('is always available (no key required)', () => {
    expect(duckduckgoProvider.isAvailable()).toBe(true)
    expect(duckduckgoProvider.isAvailable(undefined)).toBe(true)
  })

  it('parses AbstractText as answer', async () => {
    const f = mockFetch({
      AbstractText: 'TypeScript is a language.',
      AbstractURL: 'https://ts.dev',
      Heading: 'TypeScript',
      RelatedTopics: [],
    })
    const res = await duckduckgoProvider.search({ query: 'typescript', fetchImpl: f })
    expect(res.provider).toBe('duckduckgo')
    expect(res.answer).toBe('TypeScript is a language.')
    expect(res.sources).toEqual([{ title: 'TypeScript', url: 'https://ts.dev' }])
  })

  it('collects sources from RelatedTopics recursively (nested Topics)', async () => {
    const f = mockFetch({
      AbstractText: '',
      RelatedTopics: [
        { FirstURL: 'https://a.example', Text: 'Topic A' },
        {
          FirstURL: 'https://parent.example',
          Text: 'Parent',
          Topics: [{ FirstURL: 'https://nested.example', Text: 'Nested' }],
        },
      ],
    })
    const res = await duckduckgoProvider.search({ query: 'x', fetchImpl: f })
    expect(res.sources.map((s) => s.url)).toEqual([
      'https://a.example',
      'https://parent.example',
      'https://nested.example',
    ])
    expect(res.sources[2]).toEqual({
      title: 'Nested',
      url: 'https://nested.example',
      snippet: 'Nested',
    })
  })

  it('falls back title to url when Text is empty', async () => {
    const f = mockFetch({
      RelatedTopics: [{ FirstURL: 'https://notext.example', Text: '' }],
    })
    const res = await duckduckgoProvider.search({ query: 'x', fetchImpl: f })
    expect(res.sources[0]).toEqual({
      title: 'https://notext.example',
      url: 'https://notext.example',
    })
  })

  it('deduplicates sources by url', async () => {
    const f = mockFetch({
      RelatedTopics: [
        { FirstURL: 'https://dup.example', Text: 'First' },
        { FirstURL: 'https://dup.example', Text: 'Second' },
      ],
    })
    const res = await duckduckgoProvider.search({ query: 'x', fetchImpl: f })
    expect(res.sources).toHaveLength(1)
    expect(res.sources[0]?.snippet).toBe('First')
  })

  it('ignores recency (Instant Answer API does not support time filtering)', async () => {
    const f = mockFetch({ AbstractText: '', RelatedTopics: [] })
    await duckduckgoProvider.search({ query: 'x', recency: 'day', fetchImpl: f })
    const url = vi.mocked(f).mock.calls[0]?.[0] as string
    expect(url).toContain('q=x')
    expect(url).not.toContain('time_range')
    expect(url).not.toContain('recency')
  })

  it('returns empty sources when response is empty', async () => {
    const f = mockFetch({})
    const res = await duckduckgoProvider.search({ query: 'nothing', fetchImpl: f })
    expect(res.sources).toEqual([])
    expect(res.answer).toBeUndefined()
  })

  it('throws on non-2xx response', async () => {
    const f = mockFetch({ error: 'rate limited' }, 429)
    await expect(duckduckgoProvider.search({ query: 'x', fetchImpl: f })).rejects.toThrow(/429/)
  })

  it('sends GET request with required query params', async () => {
    const f = mockFetch({})
    await duckduckgoProvider.search({ query: 'react hooks', fetchImpl: f })
    const url = vi.mocked(f).mock.calls[0]?.[0] as string
    expect(url).toContain('q=react+hooks')
    expect(url).toContain('format=json')
    expect(url).toContain('no_redirect=1')
    expect(url).toContain('no_html=1')
    expect(url).toContain('t=c0de-agent')
  })
})
