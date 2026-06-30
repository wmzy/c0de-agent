import { ProxyAgent } from 'undici'

/**
 * 读 HTTPS_PROXY/HTTP_PROXY 环境变量，有则返回带 dispatcher 的 fetch，
 * 无则返回全局 fetch。仅影响本模块，不调用 setGlobalDispatcher（避免污染全局）。
 *
 * AGENTS.md 规定代理端口 7890；Node 内置 fetch 不自动走系统代理，故需包装。
 * 详见 docs/superpowers/specs/2026-06-30-websearch-tool-design.md §6。
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
    fetch(url, { ...init, dispatcher: dispatcher as RequestInit['dispatcher'] })) as typeof fetch
}
