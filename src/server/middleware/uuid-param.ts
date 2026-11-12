import type { Context } from 'hono'
import { isUuid } from '../../shared/utils/string.js'
import { apiError } from './error.js'

/**
 * UUID 路径参数守卫（单一实现）：uuid 列的路径参数（sessionId/boardId/cardId…）
 * 非 UUID 时直接 404，而不是送进 drizzle 参数化查询让 PG 抛 22P02
 * （invalid input syntax for type uuid）→ Hono 兜成 500 并回显 SQL 错误细节。
 * 「格式非法」与「资源不存在」同属资源不存在，统一 404。此前各路由各持一份
 * 守卫副本（session/kanban/todo/permissions），新路由漏抄即复发 500 泄 SQL。
 */

/** 单次校验：非法返回 404 Response，合法返回 undefined（继续正常流）。 */
function uuidParamOr404(
  c: Context,
  param: string,
  code: string,
  message: string,
): Response | undefined {
  if (!isUuid(c.req.param(param) ?? '')) {
    return apiError(c, 404, code, message)
  }
  return undefined
}

/** 中间件工厂：注册在具体处理器之前（Hono 按注册序分派，静态路由先命中
 *  即返回，不受本守卫影响；'/deleted' 等单段静态路径不匹配 '/:param' 模式）。 */
function uuidParamGuard(
  param: string,
  code: string,
  message: string,
): (c: Context, next: () => Promise<void>) => Promise<Response | undefined> {
  return async (c, next) => {
    const bad = uuidParamOr404(c, param, code, message)
    if (bad) return bad
    await next()
  }
}

export { uuidParamGuard, uuidParamOr404 }
