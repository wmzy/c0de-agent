import { describe, expect, it, vi } from 'vitest'
import { createProcessTransport } from './transport.js'

/** 轮询等待条件成立（真实子进程输出异步到达），超时抛错。 */
async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

describe('createProcessTransport', () => {
  // 复现：适配器的 stderr 管道从不读取——子进程同步写满 64KB 管道缓冲后阻塞在
  // write(2) 上，永远发不出 stdout 的 DAP 帧（握手/请求全部等不到响应）。调试
  // 适配器（js-debug 等）会向 stderr 输出日志/崩溃栈，超限即整个调试会话挂死；
  // 同时这些输出被静默丢弃，排查无据。MCP stdio 传输对同型问题已消费并透传
  // stderr（mcp/transport.ts），DAP 侧遗漏。
  it('stderr 写满管道缓冲不阻塞 stdout 帧（子进程不再卡死），且输出透传到宿主 stderr', {
    timeout: 20_000,
  }, async () => {
    const body = JSON.stringify({ seq: 1, type: 'response', request_seq: 1, success: true })
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    // 子进程：先同步写 ~5MB 到 stderr（shell 内建 printf 直写管道，写满即阻塞），
    // 之后才向 stdout 写一帧 DAP 消息。
    const script =
      `printf 'dap-stderr-marker\\n' >&2; ` +
      `for i in $(seq 1 5000); do printf '%1000s\\n' '' >&2; done; ` +
      `printf '${frame.replace(/'/g, `'\\''`)}'; sleep 30`
    const stderrSpy = vi.spyOn(process.stderr, 'write')
    const { transport } = createProcessTransport('bash', ['-c', script])
    try {
      const got: string[] = []
      transport.onData((chunk) => {
        got.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      })
      await waitFor(() => got.join('').includes('"request_seq":1'))
      expect(got.join('')).toContain(`Content-Length: ${Buffer.byteLength(body)}`)
      await waitFor(() =>
        stderrSpy.mock.calls.some((c) => String(c[0]).includes('dap-stderr-marker')),
      )
      expect(
        stderrSpy.mock.calls.some(
          (c) => String(c[0]).includes('[dap]') && String(c[0]).includes('dap-stderr-marker'),
        ),
      ).toBe(true)
    } finally {
      transport.close()
      stderrSpy.mockRestore()
    }
  })
})
