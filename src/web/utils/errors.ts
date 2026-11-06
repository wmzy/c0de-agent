/**
 * 失败原因取文案：react-query 等处的 error 是 unknown——优先取结构化
 * message（APIError / 服务端错误体的 message 字段），其次 Error.message，
 * 最后 String 兜底。此前 10 个组件各持一份本地副本且已漂移（Composer 的
 * 副本缺结构化分支，读不到 APIError 的后端文案），收敛为单源。
 */
export function messageOf(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? (e instanceof Error ? e.message : String(e))
}
