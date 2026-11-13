// 「URL 追加 token 认证 query」的单一实现。此前 terminal.ts 的 WS URL 与
// FilePreview 的媒体 URL 两处手判 ?/& 拼接（后者还要再叠 _r= 缓存令牌，判空
// 口径各自漂移），收敛于此。
//
// 使用场景都是「浏览器原生元素无法携带 Authorization 头」（WebSocket、
// img/audio/video/embed），token 只能走 query；服务端仅对白名单路径接受。

/**
 * 向 url 追加 token 与附加 query 参数：已有 query 用 & 接续，否则以 ? 起头；
 * token 为空且 extra 缺省/为空对象时原样返回（未认证/无附加参数不加尾巴）。
 * 值一律 encodeURIComponent。
 */
export function appendAuthQuery(
  url: string,
  token: string | null | undefined,
  extra?: Record<string, string | number>,
): string {
  const parts: string[] = []
  if (token) parts.push(`token=${encodeURIComponent(token)}`)
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      parts.push(`${key}=${encodeURIComponent(String(value))}`)
    }
  }
  if (parts.length === 0) return url
  return `${url}${url.includes('?') ? '&' : '?'}${parts.join('&')}`
}
