import type { Context } from 'hono'
import { apiError } from '../middleware/error.js'

/** readJsonObject 的判别结果：ok=false 时 response 为可直接 return 的 400。 */
export type JsonObjectResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response }

/**
 * 读取「必须是 JSON 对象」的请求体。
 *
 * 此前各写端点用 `await c.req.json().catch(() => ({}))` 兜底畸形 JSON——但
 * `JSON.parse('null')` 是合法 JSON，`c.req.json()` 会成功解析出 `null`，
 * catch 不触发：随后 `body.xxx` 在 null 上取属性直接 TypeError 击穿 Hono 500。
 * 数组/字符串/数字 body 同型（`body.foo` 静默 undefined，字段被当作缺省，
 * 与「请求体畸形」应有的显式反馈不符）。
 *
 * 口径：
 *  - 无 body / 空 body（curl -X POST 不带载荷）→ `{}`：这些端点的字段均为可选，
 *    保持既有契约（既有测试与脚本依赖无载荷 POST）。
 *  - 畸形 JSON / null / 数组 / 标量 body → 400（此前 null 击穿 500、
 *    其余静默当空对象）。
 *  - 合法 JSON 对象 → 原样返回。
 *
 * 调用方写法：
 *   const parsed = await readJsonObject(c)
 *   if (!parsed.ok) return parsed.response
 *   const { body } = parsed
 */
export async function readJsonObject(c: Context): Promise<JsonObjectResult> {
  const raw = await c.req.text().catch(() => '')
  if (raw.trim().length === 0) return { ok: true, body: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, response: apiError(c, 400, 'BAD_REQUEST', '请求体必须是合法 JSON') }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, response: apiError(c, 400, 'BAD_REQUEST', '请求体必须是 JSON 对象') }
  }
  return { ok: true, body: parsed as Record<string, unknown> }
}
