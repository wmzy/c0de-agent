import { describe, expect, it, vi } from 'vitest'
import { createHandoffServer, requestHandoff } from './ipc.js'

describe('handoff IPC', () => {
  it('new instance requests handoff, old instance handler invoked', async () => {
    const onHandoff = vi.fn().mockResolvedValue(undefined)
    const server = await createHandoffServer(onHandoff)
    try {
      await requestHandoff(server.port)
      expect(onHandoff).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })

  it('onHandoff error yields a non-ok response (requestHandoff rejects)', async () => {
    const onHandoff = vi.fn().mockRejectedValue(new Error('serialize failed'))
    const server = await createHandoffServer(onHandoff)
    try {
      // 错误形状：收到 HTTP 响应但非 2xx → kind='http' + status（server.ts 据此
      // 与连接层失败 kind='connect' 区分，401 时明确报 token 不匹配）。
      await expect(requestHandoff(server.port)).rejects.toMatchObject({
        kind: 'http',
        status: 500,
      })
      expect(onHandoff).toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('non-handoff path does not trigger onHandoff', async () => {
    const onHandoff = vi.fn().mockResolvedValue(undefined)
    const server = await createHandoffServer(onHandoff)
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/other`, { method: 'POST' })
      expect(res.status).toBe(404)
      expect(onHandoff).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('requestHandoff on free port rejects with kind=connect (no old instance)', async () => {
    // 用一个几乎必然空闲的高端口；连接层失败必须可与服务端拒绝（kind=http）区分，
    // 否则 server.ts 会把「无端点」误当「handoff 被拒」处理。
    await expect(requestHandoff(59999)).rejects.toMatchObject({ kind: 'connect' })
  })

  it('expectedToken 不匹配时返回 401 且不触发 onHandoff', async () => {
    const onHandoff = vi.fn().mockResolvedValue(undefined)
    const server = await createHandoffServer(onHandoff, { expectedToken: 'secret' })
    try {
      // 无 token → 401
      const resNo = await fetch(`http://127.0.0.1:${server.port}/handoff`, { method: 'POST' })
      expect(resNo.status).toBe(401)
      // 错误 token → 401
      const resBad = await fetch(`http://127.0.0.1:${server.port}/handoff`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong' },
      })
      expect(resBad.status).toBe(401)
      expect(onHandoff).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('token 不匹配经 requestHandoff 抛 kind=http status=401（可区分错误形状）', async () => {
    const onHandoff = vi.fn().mockResolvedValue(undefined)
    const server = await createHandoffServer(onHandoff, { expectedToken: 'secret' })
    try {
      // 错误 token：收到 401 响应（非连接失败）
      await expect(requestHandoff(server.port, '127.0.0.1', 'wrong')).rejects.toMatchObject({
        kind: 'http',
        status: 401,
      })
      // 无 token：同样 401
      await expect(requestHandoff(server.port)).rejects.toMatchObject({
        kind: 'http',
        status: 401,
      })
    } finally {
      await server.close()
    }
  })

  it('expectedToken 匹配时正常 handoff', async () => {
    const onHandoff = vi.fn().mockResolvedValue(undefined)
    const server = await createHandoffServer(onHandoff, { expectedToken: 'secret' })
    try {
      await requestHandoff(server.port, '127.0.0.1', 'secret')
      expect(onHandoff).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })

  // 500（onHandoff 失败）时旧实例不得 exit(0) 掩盖让渡失败——仅 200 才调度退出。
  it('onHandoff 失败（500）且 exitAfterResponse 时不调度进程退出', async () => {
    const onHandoff = vi.fn().mockRejectedValue(new Error('serialize failed'))
    const server = await createHandoffServer(onHandoff, { exitAfterResponse: true })
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit)
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/handoff`, { method: 'POST' })
      expect(res.status).toBe(500)
      // 超过 250ms 的退出调度窗口后仍不应退出（进程保留供诊断/重试）
      await new Promise((r) => setTimeout(r, 350))
      expect(exitSpy).not.toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
      await server.close()
    }
  })

  it('handoff 成功（200）且 exitAfterResponse 时延迟调度 process.exit(0)', async () => {
    const onHandoff = vi.fn().mockResolvedValue(undefined)
    const server = await createHandoffServer(onHandoff, { exitAfterResponse: true })
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit)
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/handoff`, { method: 'POST' })
      expect(res.status).toBe(200)
      // 250ms 延迟保证响应刷出后才退出
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0))
    } finally {
      exitSpy.mockRestore()
      await server.close()
    }
  })
})
