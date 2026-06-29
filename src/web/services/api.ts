import type { APIError } from '../types/index.js'

const API_BASE = ''

async function apiRequest<T>(path: string, opts?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
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
