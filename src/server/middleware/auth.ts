import type { Context, MiddlewareHandler } from 'hono'
import { apiError } from './error.js'

export type AuthOptions = {
  /** 不需认证的路径（默认放行 /api/health 探活）。 */
  publicPaths?: string[]
  /** P2-16：自定义校验函数（authManager.verify）。提供时忽略 token 字符串比较。 */
  verify?: (token: string | undefined) => boolean
}

/**
 * Bearer token 认证中间件（spec §24.2「认证」）。
 *
 * - 未配置 token（undefined/空）→ 放行，适配本地开发场景。
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
  return async (c: Context, next: () => Promise<void>) => {
    if (!expected && !opts.verify) {
      await next()
      return
    }
    if (publicPaths.has(c.req.path)) {
      await next()
      return
    }
    const auth = c.req.header('Authorization') ?? ''
    const ok = opts.verify ? opts.verify(auth.replace(/^Bearer\s+/i, '')) : auth === expected
    if (!ok) {
      return apiError(c, 401, 'UNAUTHORIZED', 'Missing or invalid bearer token')
    }
    await next()
  }
}
