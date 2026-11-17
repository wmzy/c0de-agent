import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqualString } from '../shared/utils/constant-time.js'
import { errorMessage } from '../shared/utils/string.js'

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
   * 退出延迟 250ms 保证 HTTP 响应刷出；不设时仅响应不退出（测试用 / 两阶段交接）。
   */
  exitAfterResponse?: boolean
  /**
   * 收到 POST /handoff-confirm 时调用（两阶段交接第二阶段）：
   * 新实例绑定端口成功后的确认。调用方在此清理定时器并退出进程。
   */
  onConfirm?: () => void | Promise<void>
}

/**
 * requestHandoff 抛出的可区分错误（调用方据此分流处理）：
 * - kind='connect'：连接层失败（ECONNREFUSED 等）——旧实例未启 handoff 端点，
 *   调用方应直接尝试绑端口；
 * - kind='http'：收到 HTTP 响应但非 2xx（status 为状态码）——如 401 token
 *   不匹配、500 onHandoff 失败，旧实例存在但拒绝/未能让渡。
 *   超时也归此类（无 status）：连接已建立但旧实例不回包，端口仍被其占用。
 */
type HandoffError = Error & { kind: 'connect' | 'http'; status?: number }

/** handoff 外呼超时（对照 version.ts 的 30s 口径）：旧实例 handler 挂死
 *  （接了连接不回包）时 fetch 永不 resolve，新实例 serve --restore 启动
 *  会永久阻塞，必须限时。 */
const HANDOFF_FETCH_TIMEOUT_MS = 10_000

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
      if (req.method === 'POST' && (req.url === '/handoff' || req.url === '/handoff-confirm')) {
        const authorized = opts.verify
          ? opts.verify(req.headers.authorization?.replace(/^Bearer\s+/i, ''))
          : expected.length > 0
            ? timingSafeEqualString(req.headers.authorization, expected)
            : true
        if (!authorized) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
          return
        }
        if (req.url === '/handoff-confirm') {
          // 两阶段交接第二阶段：新实例绑定成功后的确认。响应后由 onConfirm
          // 调度退出；不设 onConfirm 时直接退出（与 exitAfterResponse 独立）。
          try {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
            if (opts.onConfirm) {
              await opts.onConfirm()
            } else {
              setTimeout(() => process.exit(0), 250)
            }
          } catch (error) {
            console.error('[handoff] confirm handler failed:', error)
          }
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
async function requestHandoff(
  port: number,
  host = '127.0.0.1',
  token?: string,
  timeoutMs = HANDOFF_FETCH_TIMEOUT_MS,
): Promise<void> {
  let res: Response
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    res = await fetch(`http://${host}:${port}/handoff`, {
      method: 'POST',
      signal,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    })
  } catch (err) {
    // 超时归 kind='http' 而非 'connect'：connect 的语义是「无 handoff 端点，
    // 调用方直接试绑端口」；而超时说明连接已建立但旧实例不回包（handler 挂死，
    // 端口仍被其占用，绑端口必撞 EADDRINUSE）——归 http 让错误如实上抛，
    // 不落入「直接绑端口」的兜底分支。
    if (signal.aborted) {
      const error = new Error(
        `handoff timeout: ${host}:${port} 在 ${timeoutMs / 1000}s 内未响应（旧实例可能已挂死，请手动结束后重试）`,
      ) as HandoffError
      error.kind = 'http'
      throw error
    }
    // 连接层失败（ECONNREFUSED 等）：旧实例无 handoff 端点。抛 kind='connect'
    // 让调用方（requestHandoffWithRetry）区分处理——直接尝试绑端口。
    const error = new Error(`handoff connect failed: ${errorMessage(err)}`) as HandoffError
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

/**
 * 两阶段交接第二阶段（P3 回滚修复）：新实例绑定端口成功后 POST /handoff-confirm，
 * 旧实例收到才退出进程。连接失败/旧实例已退出时静默——确认是尽力而为，
 * 超时兜底由旧实例的复活窗口负责（端口占用状态是最终裁判）。
 */
async function confirmHandoff(
  port: number,
  host = '127.0.0.1',
  token?: string,
  timeoutMs = HANDOFF_FETCH_TIMEOUT_MS,
): Promise<void> {
  try {
    await fetch(`http://${host}:${port}/handoff-confirm`, {
      method: 'POST',
      // 超时兜底：旧实例 confirm handler 挂死时不永久等待（catch 已静默）。
      signal: AbortSignal.timeout(timeoutMs),
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    })
  } catch {
    // 旧实例已退出或不可达：无确认对象，忽略。
  }
}

export type { HandoffError, HandoffOptions, HandoffServer }
export { confirmHandoff, createHandoffServer, requestHandoff }
