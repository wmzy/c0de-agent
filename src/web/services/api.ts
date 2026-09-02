import type { APIError } from '../types/index.js'

const API_BASE = ''

const TOKEN_KEY = 'c0de-auth-token'

/**
 * 认证 token 引导（P0-3）：
 * 1. URL 携带 ?token= → 存入 localStorage 并从地址栏移除（replaceState）。
 * 2. dev 模式 vite 插件注入 window.__C0DE_AUTH_TOKEN__ → 同样入 localStorage。
 * 3. 之后所有请求经 getAuthToken 携带 Authorization 头。
 */
function bootstrapAuthToken(): void {
  if (typeof window === 'undefined') return
  try {
    const params = new URLSearchParams(window.location.search)
    const fromUrl = params.get('token')
    const injected = (window as { __C0DE_AUTH_TOKEN__?: string }).__C0DE_AUTH_TOKEN__
    if (fromUrl || injected) {
      const token = fromUrl ?? injected ?? ''
      if (token) localStorage.setItem(TOKEN_KEY, token)
      if (fromUrl) {
        params.delete('token')
        const qs = params.toString()
        const next = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
        window.history.replaceState(null, '', next)
      }
    }
  } catch {
    // 隐私模式等 localStorage 不可用场景：忽略
  }
}

bootstrapAuthToken()

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
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
