/**
 * websearch Tavily AI 搜索后端测试。
 *
 * 来源：oh-my-pi（providers/tavily），裁剪适配 c0de-agent。
 */
import { describe, expect, it, vi } from 'vitest'
import { buildRequestBody, tavilyProvider } from './tavily.js'

function mockFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('tavilyProvider', () => {
  it('is available only when apiKey is provided', () => {
    expect(tavilyProvider.isAvailable()).toBe(false)
    expect(tavilyProvider.isAvailable('')).toBe(false)
    expect(tavilyProvider.isAvailable('tvly-xxx')).toBe(true)
  })

  it('buildRequestBody omits time_range when recency not set', () => {
    const body = buildRequestBody({ query: 'q', numResults: 5 })
    expect(body).toMatchObject({
      query: 'q',
      search_depth: 'basic',
      max_results: 5,
      include_answer: 'advanced',
      include_raw_content: false,
    })
    expect('time_range' in body).toBe(false)
  })

  it('buildRequestBody adds time_range when recency is set', () => {
    const body = buildRequestBody({ query: 'q', numResults: 5, recency: 'week' })
    expect(body).toMatchObject({ time_range: 'week' })
  })

  it('search posts JSON body with Bearer auth and parses answer + results', async () => {
    const f = mockFetch({
      answer: ' React 19 ',
      results: [
        { title: 'React', url: 'https://react.dev', content: 'A JS library' },
        { title: 'Docs', url: 'https://react.dev/learn', content: 'Learn' },
      ],
      request_id: 'req-1',
    })
    const res = await tavilyProvider.search({
      query: 'react',
      apiKey: 'tvly-key',
      fetchImpl: f,
    })
    expect(res.provider).toBe('tavily')
    expect(res.answer).toBe('React 19')
    expect(res.sources).toEqual([
      { title: 'React', url: 'https://react.dev', snippet: 'A JS library' },
      { title: 'Docs', url: 'https://react.dev/learn', snippet: 'Learn' },
    ])
    // 校验请求构造
    const [url, init] = vi.mocked(f).mock.calls[0] ?? []
    expect(url).toBe('https://api.tavily.com/search')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer tvly-key')
  })

  it('skips results without url', async () => {
    const f = mockFetch({
      results: [
        { title: 'no url', content: 'x' },
        { title: 'ok', url: 'https://ok.example', content: 'y' },
      ],
    })
    const res = await tavilyProvider.search({ query: 'q', apiKey: 'k', fetchImpl: f })
    expect(res.sources).toEqual([{ title: 'ok', url: 'https://ok.example', snippet: 'y' }])
  })

  it('falls back title to url when title missing', async () => {
    const f = mockFetch({ results: [{ url: 'https://t.example', content: 'c' }] })
    const res = await tavilyProvider.search({ query: 'q', apiKey: 'k', fetchImpl: f })
    expect(res.sources[0]?.title).toBe('https://t.example')
  })

  it('throws with status on non-2xx', async () => {
    const f = mockFetch({ detail: 'invalid key' }, 401)
    await expect(
      tavilyProvider.search({ query: 'q', apiKey: 'bad', fetchImpl: f }),
    ).rejects.toThrow(/401/)
  })
})
