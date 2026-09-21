import { afterEach, describe, expect, it, vi } from 'vitest'

import { fileAPI } from '@/services/file.js'

/** 读最近一次 fetch 请求的 URL（fetch-fun 可能透传字符串或 URL 对象）。 */
function lastFetchUrl(): string {
  const calls = vi.mocked(fetch).mock.calls
  const last = calls[calls.length - 1]?.[0]
  return String(last)
}

const okResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

describe('fileAPI 路径编码', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['read', (p: string) => fileAPI.read(p)],
    ['write', (p: string) => fileAPI.write(p, 'content')],
    ['delete', (p: string) => fileAPI.delete(p)],
  ])('%s 将路径中的 ? 与 # 编码进 path 段（不被解析为 query/fragment）', async (_op, call) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()))

    await call('src/a?b.txt')
    expect(lastFetchUrl()).toContain('/api/files/src/a%3Fb.txt')

    await call('src/c#d.txt')
    expect(lastFetchUrl()).toContain('/api/files/src/c%23d.txt')
  })

  it('嵌套路径保留 / 分隔符且不重复编码 %', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()))
    await fileAPI.read('dir with space/a%20b.txt')
    const url = lastFetchUrl()
    expect(url).toContain('/api/files/dir%20with%20space/a%2520b.txt')
  })
})
