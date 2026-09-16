import type { Context, MiddlewareHandler } from 'hono'
import { isAllowedOrigin } from './cors.js'
import { apiError } from './error.js'

export type AuthOptions = {
  /** 不需认证的路径（默认放行 /api/health 探活）。 */
  publicPaths?: string[]
  /** P2-16：自定义校验函数（authManager.verify）。提供时忽略 token 字符串比较。 */
  verify?: (token: string | undefined) => boolean
  /** 认证未启用时的跨域写防线（盲 CSRF）：CORS 回显只拦「读」——恶意网页对本地
   *  服务的 POST/DELETE 等请求副作用仍会执行，只是读不到响应。开启认证（token/verify
   *  存在）时凭 token 校验已构成防线，此项不生效。 */
  allowedOrigins?: string[]
  /** 允许经 `?token=` 查询参数认证的路径判定（P1 媒体预览修复：浏览器
   *  <img>/<audio>/<video>/<embed> 元素无法携带 Authorization 头，与终端
   *  WebSocket 的 query token 同口径）。仅当 Authorization 头缺失/无效时才
   *  检查 query token——头优先，不会因路径匹配而放行任意 query token。 */
  queryTokenPath?: (path: string) => boolean
}

/**
 * Bearer token 认证中间件（spec §24.2「认证」）。
 *
 * - 未配置 token（undefined/空）→ 放行，适配本地开发场景；但对「写」请求校验
 *   Origin（仅本地回环 + allowedOrigins），补上 authEnabled=false 时 CORS 不设防的盲写面。
 * - 配置了 token → 校验 `Authorization: Bearer <token>`，不匹配返回 401。
 * - verify 提供时（P2-16 设备 token）→ 以 verify 结果为准。
 * - publicPaths 中的路径始终放行（如健康检查、认证/配对引导端点）。
 */
export function createAuthMiddleware(
  token: string | undefined,
  opts: AuthOptions = {},
): MiddlewareHandler {
  const expected = token && token.length > 0 ? `Bearer ${token}` : ''
  const publicPaths = new Set(opts.publicPaths ?? ['/api/health'])
  const queryTokenPath = opts.queryTokenPath
  return async (c: Context, next: () => Promise<void>) => {
    if (!expected && !opts.verify) {
      // 认证关闭：无 token 可验证。带 Origin 的非安全方法（浏览器跨域写）需显式放行
      // 本地/已配置 origin；无 Origin 的请求（curl/CLI/脚本/服务间调用）不受影响。
      const method = c.req.method
      const stateChanging = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
      if (stateChanging) {
        const origin = c.req.header('Origin') ?? ''
        if (origin.length > 0 && !isAllowedOrigin(origin, opts.allowedOrigins)) {
          return apiError(
            c,
            403,
            'ORIGIN_FORBIDDEN',
            'Cross-origin write rejected while authentication is disabled',
          )
        }
      }
      await next()
      return
    }
    if (publicPaths.has(c.req.path)) {
      await next()
      return
    }
    const headerAuth = c.req.header('Authorization') ?? ''
    let ok = opts.verify
      ? opts.verify(headerAuth.replace(/^Bearer\s+/i, ''))
      : headerAuth === expected
    // P1 媒体预览：浏览器媒体元素无 Authorization 头——对判定命中的路径尝试
    // query token 认证。头已有效则不再检查（头优先）；路径不匹配时 query token
    // 不参与判定，仅在白名单路径上接受 query 认证。
    if (!ok && queryTokenPath?.(c.req.path)) {
      const queryToken = c.req.query('token') ?? ''
      ok = opts.verify ? opts.verify(queryToken) : `Bearer ${queryToken}` === expected
    }
    if (!ok) {
      return apiError(c, 401, 'UNAUTHORIZED', 'Missing or invalid bearer token')
    }
    await next()
  }
}
