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
      await expect(requestHandoff(server.port)).rejects.toThrow()
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

  it('requestHandoff on free port rejects (no old instance)', async () => {
    // 用一个几乎必然空闲的高端口
    await expect(requestHandoff(59999)).rejects.toThrow()
  })
})
