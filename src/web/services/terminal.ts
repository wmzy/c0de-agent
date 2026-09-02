// src/web/services/terminal.ts

import { API_BASE, apiRequest, getAuthToken } from './api.js'

export interface TerminalInfo {
  id: string
  pid: number
  title: string
  cols: number
  rows: number
  cwd: string
  shell: string
  /** 所属项目 id（未归属时为 undefined）。 */
  projectId?: string
}

const terminalAPI = {
  list: () => apiRequest<{ terminals: TerminalInfo[] }>('/api/terminal'),
  create: (params?: {
    cwd?: string
    cols?: number
    rows?: number
    title?: string
    shell?: string
    projectId?: string
  }) =>
    apiRequest<TerminalInfo>('/api/terminal', {
      method: 'POST',
      body: JSON.stringify(params ?? {}),
    }),
  get: (id: string) => apiRequest<TerminalInfo>(`/api/terminal/${id}`),
  resize: (id: string, cols: number, rows: number, title?: string) =>
    apiRequest<TerminalInfo>(`/api/terminal/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ cols, rows, ...(title ? { title } : {}) }),
    }),
  kill: (id: string) => apiRequest<{ ok: boolean }>(`/api/terminal/${id}`, { method: 'DELETE' }),
}

/** 构建 WebSocket 连接 URL。token 通过 query 传递（浏览器 WS 不支持自定义 header）。 */
export function terminalWsUrl(id: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const base = `${proto}//${window.location.host}${API_BASE}/api/terminal/${id}/ws`
  const token = getAuthToken()
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

export { terminalAPI }
