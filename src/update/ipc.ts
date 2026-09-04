import { timingSafeEqual } from 'node:crypto'
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

type HandoffOptions = {
  /**
   * 期望的 Bearer token。设置后 /handoff 必须携带匹配的 Authorization 头，
   * 否则 401——防止任意本地进程用 POST /handoff 杀掉服务。
   * 旧实例与新实例读同一 auth-token 文件（或同一 config token），天然匹配。
   */
  expectedToken?: string
  /**
   * 自定义校验函数（P2-16：token 轮换后新旧实例 bootstrap 可能不同，
   * 用 authManager.verifyHandoff 接受当前/历史 bootstrap 与设备 token）。
   * 提供时优先于 expectedToken。
   */
  verify?: (token: string | undefined) => boolean
  /**
   * 响应发出后退出进程（旧实例完整让渡：主服务与资源已在 onHandoff 中关闭）。
   * 退出延迟 250ms 保证 HTTP 响应刷出；不设时仅响应不退出（测试用）。
   */
  exitAfterResponse?: boolean
}

/**
 * requestHandoff 抛出的可区分错误（调用方据此分流处理）：
 * - kind='connect'：连接层失败（ECONNREFUSED 等）——旧实例未启 handoff 端点，
 *   调用方应直接尝试绑端口；
 * - kind='http'：收到 HTTP 响应但非 2xx（status 为状态码）——如 401 token
 *   不匹配、500 onHandoff 失败，旧实例存在但拒绝/未能让渡。
 */
type HandoffError = Error & { kind: 'connect' | 'http'; status?: number }

/**
 * 恒时比较 Authorization 头与期望值：字符串直接比较可被时序攻击逐字符探测。
 * 长度不等直接 false——timingSafeEqual 要求等长 buffer，先比较长度本身
 * 不泄露内容信息。
 */
function authHeaderMatches(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

/**
 * 旧实例启动时创建 handoff 端点。收到 POST /handoff 即触发 onHandoff
 * （关闭主服务与资源），响应 200；exitAfterResponse 时随后退出进程。
 */
function createHandoffServer(
  onHandoff: () => Promise<void>,
  opts: HandoffOptions = {},
): Promise<HandoffServer> {
  return new Promise((resolve, reject) => {
    const expected =
      opts.expectedToken && opts.expectedToken.length > 0 ? `Bearer ${opts.expectedToken}` : ''
    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method === 'POST' && req.url === '/handoff') {
        const authorized = opts.verify
          ? opts.verify(req.headers.authorization?.replace(/^Bearer\s+/i, ''))
          : expected.length > 0
            ? authHeaderMatches(req.headers.authorization, expected)
            : true
        if (!authorized) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
          return
        }
        try {
          await onHandoff()
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          // 仅 200 才调度退出：500 时 exit(0) 会掩盖让渡失败——保留进程供
          // 诊断/重试，由下方错误日志暴露 onHandoff 失败原因。
          if (opts.exitAfterResponse) {
            setTimeout(() => process.exit(0), 250)
          }
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(error) }))
          console.error('[handoff] onHandoff failed, keeping process alive:', error)
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

/** 新实例请求旧实例让出端口（graceful shutdown）。失败抛可区分的 HandoffError。 */
async function requestHandoff(port: number, host = '127.0.0.1', token?: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(`http://${host}:${port}/handoff`, {
      method: 'POST',
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    })
  } catch (err) {
    // 连接层失败（ECONNREFUSED 等）：旧实例无 handoff 端点。抛 kind='connect'
    // 让调用方（requestHandoffWithRetry）区分处理——直接尝试绑端口。
    const error = new Error(
      `handoff connect failed: ${err instanceof Error ? err.message : String(err)}`,
    ) as HandoffError
    error.kind = 'connect'
    throw error
  }
  if (!res.ok) {
    // 收到 HTTP 响应但非 2xx（如 401 token 不匹配、500 onHandoff 失败）。
    const error = new Error(`handoff failed: HTTP ${res.status}`) as HandoffError
    error.kind = 'http'
    error.status = res.status
    throw error
  }
}

export type { HandoffError, HandoffOptions, HandoffServer }
export { createHandoffServer, requestHandoff }
