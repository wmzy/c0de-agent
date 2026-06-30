/**
 * websearch 工具定义（createWebSearchTool 工厂）测试。
 *
 * 来源：c0de-agent（对齐 runSubAgent/debugSpawn 依赖反转工厂模式）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSearchConfig } from '../../shared/types/config.js'
import type { ToolContext } from '../../shared/types/tool.js'
import { setFetchOverride } from './index.js'
import { createWebSearchTool } from './websearch.js'

function makeCtx(): ToolContext {
  return {
    cwd: '/tmp',
    session: { id: 's1', cwd: '/tmp' },
    abort: new AbortController().signal,
  }
}

const duckCfg: WebSearchConfig = { provider: 'duckduckgo' }

// 清空 key 环境变量，避免开发环境污染「lacks key」类断言。
afterEach(() => {
  setFetchOverride(undefined)
  vi.stubEnv('TAVILY_API_KEY', '')
  vi.stubEnv('BRAVE_API_KEY', '')
  vi.unstubAllEnvs()
})

describe('createWebSearchTool', () => {
  it('defines name/description/permission=auto/timeout', () => {
    const tool = createWebSearchTool(duckCfg)
    expect(tool.name).toBe('websearch')
    expect(tool.permission).toBe('auto')
    expect(tool.timeout).toBe(30_000)
    expect(tool.description).toContain('web')
    expect(tool.parameters.required).toEqual(['query'])
  })

  it('returns formatted success output on results', async () => {
    const tool = createWebSearchTool(duckCfg)
    const f = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ AbstractText: 'TS', AbstractURL: 'https://ts.dev', Heading: 'TS' }),
          { status: 200 },
        ),
      ) as unknown as typeof fetch
    setFetchOverride(f)
    const result = await tool.execute({ query: 'typescript' }, makeCtx())
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toContain('TS')
      expect(result.output).toContain('https://ts.dev')
    }
  })

  it('returns no-results message when sources empty and no answer', async () => {
    const tool = createWebSearchTool(duckCfg)
    const f = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 }),
      ) as unknown as typeof fetch
    setFetchOverride(f)
    const result = await tool.execute({ query: 'zzz' }, makeCtx())
    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.output).toMatch(/no search results/i)
    }
  })

  it('returns error on fetch failure', async () => {
    const tool = createWebSearchTool(duckCfg)
    const f = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    setFetchOverride(f)
    const result = await tool.execute({ query: 'x' }, makeCtx())
    expect(result._tag).toBe('error')
    if (result._tag === 'error') expect(result.error).toContain('network down')
  })

  it('returns error when explicit provider lacks key', async () => {
    const tool = createWebSearchTool({ provider: 'tavily' })
    const result = await tool.execute({ query: 'x' }, makeCtx())
    expect(result._tag).toBe('error')
    if (result._tag === 'error') expect(result.error).toMatch(/tavily/i)
  })

  it('passes abort signal through', async () => {
    const tool = createWebSearchTool(duckCfg)
    const ac = new AbortController()
    const f = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 }),
      ) as unknown as typeof fetch
    setFetchOverride(f)
    const ctx = { ...makeCtx(), abort: ac.signal }
    await tool.execute({ query: 'x' }, ctx)
    const [, init] = vi.mocked(f).mock.calls[0] ?? []
    expect(init?.signal).toBe(ac.signal)
  })
})
