import type { Context, MiddlewareHandler } from 'hono'
import { apiError } from './error.js'

export type AuthOptions = {
  /** 不需认证的路径（默认放行 /api/health 探活）。 */
  publicPaths?: string[]
}

/**
 * Bearer token 认证中间件（spec §24.2「认证」）。
 *
 * - 未配置 token（undefined/空）→ 放行，适配本地开发场景。
 * - 配置了 token → 校验 `Authorization: Bearer <token>`，不匹配返回 401。
 * - publicPaths 中的路径始终放行（如健康检查）。
 *
 * 生产或远程访问场景应在 config.security.token 配置随机 token。
 */
export function createAuthMiddleware(
  token: string | undefined,
  opts: AuthOptions = {},
): MiddlewareHandler {
  const expected = token && token.length > 0 ? `Bearer ${token}` : ''
  const publicPaths = new Set(opts.publicPaths ?? ['/api/health'])
  return async (c: Context, next: () => Promise<void>) => {
    if (!expected) {
      await next()
      return
    }
    if (publicPaths.has(c.req.path)) {
      await next()
      return
    }
    const auth = c.req.header('Authorization') ?? ''
    if (auth !== expected) {
      return apiError(c, 401, 'UNAUTHORIZED', 'Missing or invalid bearer token')
    }
    await next()
  }
}
