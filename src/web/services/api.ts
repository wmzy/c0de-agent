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
    const body = await response.json().catch(() => ({ message: response.statusText }))
    const error: APIError = {
      status: response.status,
      message: (body as { message?: string }).message ?? response.statusText,
      code: (body as { code?: string }).code,
    }
    throw error
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export { API_BASE, apiRequest }
