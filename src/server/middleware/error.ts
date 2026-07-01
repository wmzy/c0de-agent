// src/server/middleware/error.ts

import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { APIErrorBody } from '../types.js'

/** 构建标准 JSON 错误响应。 */
function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return c.json<APIErrorBody>({ error: { code, message, ...(details ? { details } : {}) } }, status)
}

/** Hono onError 处理器：捕获未处理异常，返回 500。 */
function errorHandler(err: Error, c: Context): Response {
  const message = err instanceof Error ? err.message : 'Internal server error'
  return c.json<APIErrorBody>({ error: { code: 'INTERNAL', message } }, 500)
}

export { apiError, errorHandler }
