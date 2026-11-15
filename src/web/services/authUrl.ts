import { appendQuery } from '@/services/api.js'

// 「URL 追加 token 认证 query」的单一实现。此前 terminal.ts 的 WS URL 与
// FilePreview 的媒体 URL 两处手判 ?/& 拼接（后者还要再叠 _r= 缓存令牌，判空
// 口径各自漂移），收敛于此。
//
// 使用场景都是「浏览器原生元素无法携带 Authorization 头」（WebSocket、
// img/audio/video/embed），token 只能走 query；服务端仅对白名单路径接受。
// 拼接骨架（?/& 分隔、encodeURIComponent、空参数原样返回）委托 api.ts 的
// appendQuery；本层只保留 token 缺省不注入与 extra 值的 string 化。api.ts
// 不依赖本模块，委托方向无循环。

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
  const params: Record<string, string> = {}
  if (token) params.token = token
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      params[key] = String(value)
    }
  }
  return appendQuery(url, params)
}
