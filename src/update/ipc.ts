import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/**
 * 端口接管 IPC（spec §18.3）：新实例检测到端口被旧实例占用时，通过 HTTP
 * `/handoff` 端点请求旧实例 graceful shutdown（序列化状态后退出），从而
 * 接管端口。用普通 HTTP 而非 unix socket，便于跨平台。
 */

type HandoffServer = {
  port: number
  close: () => Promise<void>
}

/** 旧实例启动时创建 handoff 端点。收到 POST /handoff 即触发 onHandoff（序列化 + 退出）。 */
function createHandoffServer(onHandoff: () => Promise<void>): Promise<HandoffServer> {
  return new Promise((resolve, reject) => {
    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method === 'POST' && req.url === '/handoff') {
        try {
          await onHandoff()
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(error) }))
        }
        return
      }
      res.writeHead(404)
      res.end()
    }
    const server: Server = createServer(handler)
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}

/** 新实例请求旧实例让出端口（graceful shutdown）。失败抛错。 */
async function requestHandoff(port: number, host = '127.0.0.1'): Promise<void> {
  const res = await fetch(`http://${host}:${port}/handoff`, { method: 'POST' })
  if (!res.ok) throw new Error(`handoff failed: HTTP ${res.status}`)
}

export type { HandoffServer }
export { createHandoffServer, requestHandoff }
