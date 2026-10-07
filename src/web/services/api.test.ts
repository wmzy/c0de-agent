import { afterEach, describe, expect, it, vi } from 'vitest'

import { del, get, post, put } from '@/services/api.js'
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

  // 回归：APIError 此前是普通对象字面量，全仓 30+ 处
  // `err instanceof Error ? err.message : String(err)` 恒走 else 分支——
  // String({status,message}) 渲染成「[object Object]」，用户在添加项目、
  // 永久删除会话、恢复归档等失败处看不到后端给出的原因。
  it('抛出的错误是真正的 Error：instanceof 成立且 message 可直接取用', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { code: 'INTERNAL', message: '项目目录不可写：/etc/c0de' } }),
            { status: 500, statusText: 'Internal Server Error' },
          ),
        ),
    )
    const err = await get('/api/projects/from-directory').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('项目目录不可写：/etc/c0de')
    // 常规消费写法（此前必得 "[object Object]"）
    expect(String((err as Error).message)).not.toContain('[object Object]')
    // 结构化读取不变：status/code 与 JSON 序列化行为保持原契约
    expect(err).toMatchObject({ status: 500, code: 'INTERNAL' })
    expect(JSON.parse(JSON.stringify(err))).toMatchObject({
      message: '项目目录不可写：/etc/c0de',
      status: 500,
    })
  })

  // 回归：fetch 本身失败此前原样抛出，各视图直接渲染 e.message，
  // 用户看到英文原文「Failed to fetch」，既没翻译也没说该做什么。
  it('fetch 失败（非 HTTP）包装成中文 NETWORK 错误，不再抛 Failed to fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const err = await get('/api/health').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('网络请求失败，请确认 c0de 服务仍在运行后重试')
    expect((err as Error).message).not.toContain('Failed to fetch')
    expect(err).toMatchObject({ status: 0, code: 'NETWORK' })
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

  // 回归：withRetry 此前未声明方法白名单，取 fetch-fun 默认集
  // （GET/HEAD/OPTIONS/TRACE/**PUT/DELETE**）——PUT/DELETE 写操作被重放，与
  // 本层声明的「仅幂等 GET，写操作永不重放」契约相悖：删除类请求（文件移入
  // 回收站、彻底删除会话/看板）首次已成功但响应丢失（超时/连接中断）时，重放
  // 拿到 404 并报「删除失败」，用户以为没删掉。
  it('PUT/DELETE 不重试（写操作永不重放，与 POST 同口径）', async () => {
    for (const call of [
      () => put('/api/files/a.ts', { content: 'x' }),
      () => del('/api/sessions/x'),
    ]) {
      let calls = 0
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => {
          calls++
          return new Response('{"error":{"message":"boom"}}', { status: 500 })
        }),
      )
      await expect(call()).rejects.toMatchObject({ status: 500 })
      expect(calls).toBe(1)
    }
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
