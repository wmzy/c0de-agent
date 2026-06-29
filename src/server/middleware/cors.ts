import type { Context, MiddlewareHandler } from 'hono'

/** 本地回环 origin 模式：http(s)://(localhost|127.0.0.1|[::1])(:port)。 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

/**
 * 判断 origin 是否为本地/可信来源（spec §24.2「CORS 限制本地 origin」）。
 * 允许：本机回环任意端口、file://（PWA 安装后）、浏览器扩展、'null'
 * （file 协议/隐私沙箱发出的 Origin 头）。
 */
export function isLocalOrigin(origin: string): boolean {
  if (!origin) return false
  if (LOCAL_ORIGIN.test(origin)) return true
  if (origin === 'null') return true
  if (origin.startsWith('file://')) return true
  if (origin.startsWith('chrome-extension://')) return true
  if (origin.startsWith('moz-extension://')) return true
  return false
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
