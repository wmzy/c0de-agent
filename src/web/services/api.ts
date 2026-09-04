import type { APIError } from '../types/index.js'

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
          const body = (await res.json()) as { deviceToken?: string }
          if (body.deviceToken) {
            localStorage.setItem(TOKEN_KEY, body.deviceToken)
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

/** 通知 App 显示设备配对 UI（apiRequest 收到 401 时调用）。 */
function emitAuthRequired(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('c0de-auth-required'))
}

async function apiRequest<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = getAuthToken()
  const response = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts?.headers,
    },
    credentials: 'same-origin',
  })

  if (!response.ok) {
    // P2-16：401 → 通知配对 UI 接管（不再静默抛错让页面空白）。
    if (response.status === 401) {
      emitAuthRequired()
    }
    // 后端 apiError 返回 { error: { code, message } }；兼容旧/裸 { message } 与无 JSON（fallback statusText）。
    const body = await response.json().catch(() => ({ message: response.statusText }))
    const errBody = (body as { error?: { code?: string; message?: string } }).error
    const error: APIError = {
      status: response.status,
      message: errBody?.message ?? (body as { message?: string }).message ?? response.statusText,
      code: errBody?.code ?? (body as { code?: string }).code,
    }
    throw error
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export { API_BASE, apiRequest }
