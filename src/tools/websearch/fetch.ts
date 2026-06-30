import { ProxyAgent, fetch as undiciFetch } from 'undici'

/**
 * 读 HTTPS_PROXY/HTTP_PROXY 环境变量，有则返回带 dispatcher 的 fetch，
 * 无则返回全局 fetch。仅影响本模块，不调用 setGlobalDispatcher（避免污染全局）。
 *
 * AGENTS.md 规定代理端口 7890；Node 内置 fetch 不自动走系统代理，故需包装。
 *
 * 注意：必须用 npm 包 undici 自带的 `fetch`（与 ProxyAgent 同版本）发起请求，
 * 而非 Node 全局 fetch——Node 捆绑的 undici 与 npm 安装的 undici 版本不同，
 * 跨版本传 Dispatcher 会被拒绝（UND_ERR_INVALID_ARG）。详见设计文档 §6。
 */
export function createFetch(): typeof fetch {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  if (!proxy) return fetch
  const dispatcher = new ProxyAgent(proxy)
  return ((url: string | URL | Request, init?: RequestInit) =>
    undiciFetch(
      url as unknown as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
    )) as typeof fetch
}
