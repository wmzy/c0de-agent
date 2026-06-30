/**
 * websearch 注册表、provider 选择与格式化测试。
 *
 * 来源：oh-my-pi（provider 注册表 + resolveProvider 范式），裁剪适配 c0de-agent。
 */
import { describe, expect, it, vi } from 'vitest'
import type { WebSearchConfig } from '../../shared/types/config.js'
import { formatForLLM, resolveProvider, runWebSearch, setFetchOverride } from './index.js'
import type { WebSearchResponse } from './types.js'

/** 构造 WebSearchConfig；keys 映射到 tavilyApiKey/braveApiKey 字段。 */
function cfg(
  provider: WebSearchConfig['provider'],
  keys?: { tavily?: string; brave?: string },
): WebSearchConfig {
  return {
    provider,
    ...(keys?.tavily !== undefined ? { tavilyApiKey: keys.tavily } : {}),
    ...(keys?.brave !== undefined ? { braveApiKey: keys.brave } : {}),
  }
}

describe('resolveProvider', () => {
  it('auto falls back to duckduckgo when no keys', () => {
    expect(resolveProvider('auto', {}).id).toBe('duckduckgo')
  })

  it('auto prefers tavily when key present', () => {
    expect(resolveProvider('auto', { tavily: 't' }).id).toBe('tavily')
  })

  it('auto prefers brave over duckduckgo when brave key present (no tavily)', () => {
    expect(resolveProvider('auto', { brave: 'b' }).id).toBe('brave')
  })

  it('auto prefers tavily over brave when both present', () => {
    expect(resolveProvider('auto', { tavily: 't', brave: 'b' }).id).toBe('tavily')
  })

  it('explicit provider is honored even if key missing for duckduckgo', () => {
    expect(resolveProvider('duckduckgo', {}).id).toBe('duckduckgo')
  })

  it('explicit tavily without key throws', () => {
    expect(() => resolveProvider('tavily', {})).toThrow(/tavily/i)
  })

  it('explicit brave without key throws', () => {
    expect(() => resolveProvider('brave', {})).toThrow(/brave/i)
  })
})

describe('formatForLLM', () => {
  it('formats answer + numbered sources with truncated snippets', () => {
    const res: WebSearchResponse = {
      provider: 'tavily',
      answer: 'It is a language.',
      sources: [
        { title: 'A', url: 'https://a.example', snippet: 'short' },
        { title: 'B', url: 'https://b.example', snippet: 'x'.repeat(300) },
      ],
    }
    const out = formatForLLM(res)
    expect(out).toContain('It is a language.')
    expect(out).toContain('## Sources (2)')
    expect(out).toContain('[1] A')
    expect(out).toContain('https://a.example')
    expect(out).toContain('short')
    // snippet 截断到 240
    expect(out).toContain('[2] B')
    expect(out).not.toContain('x'.repeat(300))
  })

  it('omits Sources section when no sources', () => {
    const out = formatForLLM({ provider: 'duckduckgo', sources: [] })
    expect(out).not.toContain('## Sources')
  })

  it('omits snippet line when absent', () => {
    const out = formatForLLM({
      provider: 'duckduckgo',
      sources: [{ title: 'A', url: 'https://a.example' }],
    })
    expect(out).toContain('[1] A')
    expect(out).toContain('https://a.example')
    expect(out.split('\n').filter((l) => l.trim().startsWith('https')).length).toBe(1)
  })
})

describe('runWebSearch', () => {
  it('injects fetchImpl via module-level override (duckduckgo, mocked)', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ AbstractText: 'ok', AbstractURL: 'https://x' }), {
        status: 200,
      }),
    ) as unknown as typeof fetch
    setFetchOverride(f)
    try {
      const res = await runWebSearch(
        { query: 'typescript' },
        cfg('duckduckgo'),
        new AbortController().signal,
      )
      expect(res.provider).toBe('duckduckgo')
      expect(res.answer).toBe('ok')
    } finally {
      setFetchOverride(undefined)
    }
  })

  it('resolves tavily via config key when env unset', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ answer: 'hi', results: [] }), { status: 200 }),
      ) as unknown as typeof fetch
    setFetchOverride(f)
    const prevTavily = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    try {
      const res = await runWebSearch(
        { query: 'q' },
        cfg('tavily', { tavily: 'tvly-from-config' }),
        new AbortController().signal,
      )
      expect(res.provider).toBe('tavily')
      const init = vi.mocked(f).mock.calls[0]?.[1]
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer tvly-from-config',
      )
    } finally {
      setFetchOverride(undefined)
      if (prevTavily !== undefined) process.env.TAVILY_API_KEY = prevTavily
    }
  })
})
