import { afterEach, describe, expect, it, vi } from 'vitest'

import { del, get, post } from '@/services/api.js'
import { sendChatMessage } from '@/services/chat.js'

/** 读请求头：fetch-fun 在 happy-dom 产出 Headers 实例、bun 产出普通对象，按名大小写不敏感读取。 */
function readHeader(init: RequestInit, name: string): string | undefined {
  const h = init.headers
  if (h instanceof Headers) return h.get(name) ?? undefined
  const rec = h as Record<string, string>
  return rec[name] ?? rec[name.toLowerCase()] ?? rec[name.toUpperCase()]
}

describe('fetch-fun HTTP 层', () => {
  afterEach(() => vi.restoreAllMocks())

  it('get 返回解析后的 JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    )
    const result = await get('/api/health')
    expect(result).toEqual({ ok: true })
  })

  it('非 2xx 解析后端 { error: { code, message } } 并抛出 APIError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          // 与服务端 apiError(middleware/error.ts) 实际返回体一致
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Session not found' } }),
          { status: 404, statusText: 'Not Found' },
        ),
      ),
    )
    await expect(get('/api/sessions/x')).rejects.toMatchObject({
      status: 404,
      message: 'Session not found',
      code: 'NOT_FOUND',
    })
  })

  it('无 JSON body 时回退到 statusText', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('boom', { status: 404, statusText: 'Not Found' })),
    )
    await expect(get('/api/whatever')).rejects.toMatchObject({
      status: 404,
      message: 'Not Found',
    })
  })

  it('401 时派发 c0de-auth-required 事件并抛出 APIError', async () => {
    const handler = vi.fn()
    window.addEventListener('c0de-auth-required', handler)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no' } }), {
          status: 401,
          statusText: 'Unauthorized',
        }),
      ),
    )
    await expect(get('/api/health')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' })
    expect(handler).toHaveBeenCalledTimes(1)
    window.removeEventListener('c0de-auth-required', handler)
  })

  it('del 204 返回 undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    const result = await del('/api/sessions/x')
    expect(result).toBeUndefined()
  })

  it('GET 瞬时 5xx 重试后成功（幂等白名单）', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        calls++
        if (calls < 3) return new Response('{"error":{"message":"boom"}}', { status: 500 })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }),
    )
    const result = await get('/api/health')
    expect(result).toEqual({ ok: true })
    expect(calls).toBe(3)
  })

  it('POST 不重试（写操作永不重放）', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        calls++
        return new Response('{"error":{"message":"boom"}}', { status: 500 })
      }),
    )
    await expect(post('/api/chat/abort', { sessionId: 's' })).rejects.toMatchObject({ status: 500 })
    expect(calls).toBe(1)
  })

  it('localStorage 有 token 时携带 Authorization 头', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'c0de-auth-token' ? 'tok-123' : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await get('/api/health')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(readHeader(init, 'authorization')).toBe('Bearer tok-123')
  })

  it('无 token 时不携带 Authorization 头', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await get('/api/health')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(readHeader(init, 'authorization')).toBeUndefined()
  })

  it('bootstrapAuthToken 将 URL ?token= 存入 localStorage', async () => {
    const setItem = vi.fn()
    const replaceState = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem, removeItem: vi.fn() })
    vi.stubGlobal('history', { replaceState, pushState: vi.fn() })
    // 重新加载模块触发 bootstrap（search 含 token）
    vi.resetModules()
    Object.defineProperty(window, 'location', {
      value: {
        search: '?token=tok-url&other=1',
        pathname: '/',
        hash: '',
        href: 'http://localhost/?token=tok-url&other=1',
      },
      configurable: true,
    })
    await import('@/services/api.js')
    expect(setItem).toHaveBeenCalledWith('c0de-auth-token', 'tok-url')
    expect(replaceState).toHaveBeenCalled()
    const nextUrl = replaceState.mock.calls[0]?.[2] as string
    expect(nextUrl).not.toContain('token')
    expect(nextUrl).toContain('other=1')
  })

  it('已有设备 token 时 dev 注入的 bootstrap 不覆盖已存 token（防配对死循环）', async () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'c0de-auth-token' ? 'device-token' : null),
      setItem,
      removeItem: vi.fn(),
    })
    vi.stubGlobal('history', { replaceState: vi.fn(), pushState: vi.fn() })
    vi.stubGlobal('fetch', vi.fn())
    // 模拟 dev 注入 bootstrap，但无 URL token
    Object.defineProperty(window, '__C0DE_AUTH_TOKEN__', {
      value: 'injected-bootstrap',
      configurable: true,
    })
    vi.resetModules()
    Object.defineProperty(window, 'location', {
      value: {
        search: '',
        pathname: '/',
        hash: '',
        href: 'http://localhost/',
      },
      configurable: true,
    })
    await import('@/services/api.js')
    // 不得用 injected-bootstrap 覆盖设备 token（否则注册失败 → 401 → 配对循环）
    expect(setItem).not.toHaveBeenCalledWith('c0de-auth-token', 'injected-bootstrap')
  })
})

// 回归（P0-1）：sendChatMessage 此前走原生 fetch 且不带 Authorization，
// authEnabled 默认开启时 /api/chat 全部 401，被 useChat 当作流中断。必须与
// apiRequest 一样条件携带 Bearer 头。
describe('sendChatMessage 认证头', () => {
  afterEach(() => vi.restoreAllMocks())

  function stubToken(token: string | null) {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'c0de-auth-token' ? token : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
  }

  it('localStorage 有 token 时 /api/chat 携带 Authorization 头', async () => {
    stubToken('tok-123')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    await sendChatMessage('s1', 'hi', () => {})
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
  })

  it('无 token 时不携带 Authorization 头', async () => {
    stubToken(null)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    await sendChatMessage('s1', 'hi', () => {})
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('401 时错误提示附「重新进入」指引', async () => {
    stubToken('tok-123')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendChatMessage('s1', 'hi', () => {})).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('重新进入'),
    })
  })
})
