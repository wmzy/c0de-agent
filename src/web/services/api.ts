import * as ff from 'fetch-fun'
import type { APIError } from '@/types/index.js'

const API_BASE = ''

const TOKEN_KEY = 'c0de-auth-token'

/**
 * P2-16 认证引导：
 * 1. URL 携带 ?token=（bootstrap）→ 尝试 POST /api/auth/register 换发设备 token。
 *    成功 → 存储设备 token；失败（已有设备注册过 bootstrap / 静态 token 模式）
 *    → 暂存 URL token 并延迟到首次 API 请求校验，失败再进入配对流程。
 * 2. dev 模式 vite 插件注入 window.__C0DE_AUTH_TOKEN__ → 同 URL 流程。
 * 3. 所有请求经 getAuthToken 携带 Authorization 头。
 * 4. 401 时派发 'c0de-auth-required' 事件 → App 挂载的配对 UI 接管。
 */
function bootstrapAuthToken(): void {
  if (typeof window === 'undefined') return
  try {
    const params = new URLSearchParams(window.location.search)
    const fromUrl = params.get('token')
    const injected = (window as { __C0DE_AUTH_TOKEN__?: string }).__C0DE_AUTH_TOKEN__
    // URL token 优先级最高（显式注册意图，覆盖一切）。
    // dev 注入的 bootstrap 仅在**尚无任何已存 token** 时作为候选——
    // 否则每次页面加载都用 bootstrap 覆盖有效设备 token，注册又因 devices>0 失败，
    // 陷入 401 → 配对死循环（P1-4 修复）。
    const existing = localStorage.getItem(TOKEN_KEY)
    const rawToken = fromUrl ?? (existing ? null : (injected ?? ''))
    if (rawToken) {
      if (fromUrl) {
        params.delete('token')
        const qs = params.toString()
        const next = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
        window.history.replaceState(null, '', next)
      }
      // 先同步存储原始 token（保证刷新后立即可用），再异步换发设备 token：
      // 注册成功 → 覆盖为设备 token（bootstrap 轮换后 API 只认设备 token）。
      localStorage.setItem(TOKEN_KEY, rawToken)
      // 换发设备 token（fire-and-forget；成功即覆盖持久化，失败保留原始 token 由 API 401 触发配对）
      if (typeof fetch !== 'function') return
      void fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: rawToken,
          deviceName: `Browser (${navigator.platform ?? 'unknown'})`,
        }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status))
          const body = (await res.json()) as { deviceToken?: string; deviceName?: string }
          if (body.deviceToken) {
            localStorage.setItem(TOKEN_KEY, body.deviceToken)
            // P1-3：记录注册成功的设备名，刷新后展示一次性确认，用户可核对
            // 首设备注册的确实是本浏览器（先到先得竞态的可见性补偿）。
            if (body.deviceName) {
              try {
                sessionStorage.setItem('c0de-auth-registered', body.deviceName)
              } catch {
                // sessionStorage 不可用时跳过提示，不阻塞刷新
              }
            }
            // 设备 token 生效后刷新一次：注册期间的并发请求可能已因 bootstrap 401
            // 触发配对 UI，刷新以设备 token 重新加载避免用户卡在配对页。
            window.location.reload()
          }
        })
        .catch(() => {
          // bootstrap 已失效（已有设备）或静态 token 模式：保留原始 token，
          // 首次 API 请求若 401 再触发配对流程。
        })
    }
  } catch {
    // 隐私模式等 localStorage 不可用场景：忽略
  }
}

bootstrapAuthToken()

/** 清除本地 token（配对拒绝/登出后调用）。 */
export function clearAuthToken(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    // ignore
  }
}

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

/** 通知 App 显示设备配对 UI（收到 401 时调用）。 */
function emitAuthRequired(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('c0de-auth-required'))
}

/**
 * 请求链（fetch-fun 管道，形态对齐 painless 模板 http.ts）：
 * - timeout=每趟尝试预算（新信号），totalTimeout=整链预算；
 *   后端多为本机接口，但 provider 探测等会代理外部端点，预算放宽到 30s/120s。
 * - withAuth 每趟尝试重取 token（getAuthToken 每次请求时求值）；空凭据跳过报头。
 * - withRetry(2) 仅白名单幂等方法（GET），写操作永不重放。
 */
const client = ff
  .create({ baseUrl: API_BASE })
  .pipe(ff.header, 'content-type', 'application/json')
  .pipe(ff.header, 'accept', 'application/json')
  .pipe(ff.timeout, 30_000)
  .pipe(ff.totalTimeout, 120_000)
  .pipe(
    ff.use,
    ff.withAuth(() => getAuthToken() ?? '', 'Bearer'),
  )
  .pipe(ff.use, ff.withRetry(2))

// 请求函数只收 api 派生链：phantom symbol 无法自然构造，
// auth/401/retry/timeout 不变量由约定升级为类型保证（painless http.ts 同款）。
declare const apiBrand: unique symbol

/** 由基链派生的客户端类型。 */
export type ApiClient = ff.Options & ff.Pipe & { readonly [apiBrand]: never }

const api = client as unknown as ApiClient

/**
 * HTTPError → APIError 契约（服务端 { error: { code, message, details? } }，
 * 兼容旧/裸 { message } 与无 JSON（fallback statusText））。
 * 错误体在重试耗尽的最终错误上解析一次。
 */
async function toAPIError(e: ff.HTTPError): Promise<APIError> {
  let body: unknown = e.data
  if (body === undefined) {
    try {
      body = await e.response.clone().json()
    } catch {
      // 非 JSON 错误体：保持 undefined，message 落回 statusText
    }
  }
  const errBody = (
    body as
      | { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
      | undefined
  )?.error
  const flat = body as { message?: string; code?: string } | undefined
  return {
    status: e.status,
    message: errBody?.message ?? flat?.message ?? e.response.statusText,
    ...((errBody?.code ?? flat?.code) ? { code: (errBody?.code ?? flat?.code) as string } : {}),
    // P0-2：details 随错误下发（TRUST_REQUIRED 的风险项等），此前被静默丢弃。
    ...(errBody?.details ? { details: errBody.details } : {}),
  }
}

async function request<T>(
  url: string,
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  let o = ff.url(api, url)
  if (method) o = ff.method(o, method)
  if (body !== undefined) o = ff.jsonBody(o, body)
  try {
    return await (ff.fetchJSON<T>(o) as Promise<T>)
  } catch (e) {
    if (e instanceof ff.HTTPError) {
      // P2-16：401 → 通知配对 UI 接管（不再静默抛错让页面空白）。
      if (e.status === 401) emitAuthRequired()
      throw await toAPIError(e)
    }
    throw e
  }
}

export function get<T = unknown>(url: string): Promise<T> {
  return request<T>(url)
}

export function post<T = unknown>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, 'POST', body)
}

export function put<T = unknown>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, 'PUT', body)
}

export function patch<T = unknown>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, 'PATCH', body)
}

/** 204 空响应体 → undefined（同 apiRequest 旧契约）。 */
export function del<T = unknown>(url: string): Promise<T> {
  return request<T>(url, 'DELETE')
}

export { API_BASE }
