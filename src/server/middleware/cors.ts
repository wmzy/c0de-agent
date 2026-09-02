import type { Context, MiddlewareHandler } from 'hono'

/** 本地回环 origin 模式：http(s)://(localhost|127.0.0.1|[::1])(:port)。 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

/**
 * 判断 origin 是否为本地/可信来源（spec §24.2「CORS 限制本地 origin」）。
 *
 * 仅允许本机回环任意端口 + 显式配置的 allowedOrigins。
 * 显式不放行 'null'（sandboxed iframe）、file:// 与浏览器扩展前缀——
 * 任意网页/扩展均可伪造这些来源，等价于完全关闭 CORS 防护。
 * 认证未启用时（authEnabled=false 的显式选择），本函数仍是唯一的跨域读取防线。
 */
export function isLocalOrigin(origin: string): boolean {
  if (!origin) return false
  return LOCAL_ORIGIN.test(origin)
}

/**
 * Origin 是否被允许（本地回环 + 配置的额外 origin）。
 * 供 CORS 中间件与 WebSocket 升级路径共用——浏览器对 WS 不实施 CORS，
 * 但会携带 Origin 头，必须在服务端显式校验。
 */
export function isAllowedOrigin(origin: string, allowedOrigins?: string[]): boolean {
  if (isLocalOrigin(origin)) return true
  return allowedOrigins?.includes(origin) ?? false
}

export type CORSOptions = {
  /** 额外允许的 origin（如远程访问场景配置的域名）。 */
  allowedOrigins?: string[]
}

/**
 * CORS 中间件：仅对本地/可信 origin 回显 Access-Control-Allow-Origin，
 * 拒绝外部网页跨域读取本地 server（spec §24.2）。处理 OPTIONS 预检。
 */
export function createCORSMiddleware(opts: CORSOptions = {}): MiddlewareHandler {
  const extra = new Set(opts.allowedOrigins ?? [])
  return async (c: Context, next: () => Promise<void>) => {
    const origin = c.req.header('Origin') ?? ''
    const allowed = isLocalOrigin(origin) || extra.has(origin)
    if (origin.length > 0 && allowed) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Vary', 'Origin')
    }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      c.header('Access-Control-Max-Age', '86400')
      return c.body(null, 204)
    }
    await next()
  }
}
