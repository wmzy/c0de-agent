// src/web/services/terminal.ts

import type { PTYInfo as TerminalInfo } from '@shared/types/terminal.js'
import { API_BASE, del, get, getAuthToken, post, put } from '@/services/api.js'
import { appendAuthQuery } from '@/services/authUrl.js'

// 契约正本在 @shared/types/terminal.ts（服务端 pty-manager 的 PTYInfo 同一形状）。
export type { TerminalInfo }

const terminalAPI = {
  list: () => get<{ terminals: TerminalInfo[] }>('/api/terminal'),
  create: (params?: {
    cwd?: string
    cols?: number
    rows?: number
    title?: string
    shell?: string
    projectId?: string
  }) => post<TerminalInfo>('/api/terminal', params ?? {}),
  get: (id: string) => get<TerminalInfo>(`/api/terminal/${id}`),
  resize: (id: string, cols: number, rows: number, title?: string) =>
    put<TerminalInfo>(`/api/terminal/${id}`, { cols, rows, ...(title ? { title } : {}) }),
  kill: (id: string) => del<{ ok: boolean }>(`/api/terminal/${id}`),
}

/** 构建 WebSocket 连接 URL。token 通过 query 传递（浏览器 WS 不支持自定义 header）。 */
export function terminalWsUrl(id: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const base = `${proto}//${window.location.host}${API_BASE}/api/terminal/${id}/ws`
  // token query 的拼接与 FilePreview 媒体 URL 同一实现（appendAuthQuery 单源）
  return appendAuthQuery(base, getAuthToken())
}

export { terminalAPI }
