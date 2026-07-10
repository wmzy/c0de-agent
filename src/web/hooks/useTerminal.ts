// src/web/hooks/useTerminal.ts

import { useCallback, useEffect, useRef, useState } from 'react'
import { terminalAPI, terminalWsUrl, type TerminalInfo } from '../services/terminal.js'

export interface TerminalSession extends TerminalInfo {
  /** WebSocket 连接（null = 未连接/已断开）。 */
  ws: WebSocket | null
  /** 是否正在连接中。 */
  connecting: boolean
}

const TERMINAL_HEIGHT_KEY = 'c0de-agent:terminalHeight'
const TERMINAL_OPEN_KEY = 'c0de-agent:terminalOpen'
const DEFAULT_HEIGHT = 240
const MIN_HEIGHT = 100
const MAX_HEIGHT = 800

function loadHeight(): number {
  const raw = localStorage.getItem(TERMINAL_HEIGHT_KEY)
  if (raw == null) return DEFAULT_HEIGHT
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, n)) : DEFAULT_HEIGHT
}

function loadOpen(): boolean {
  return localStorage.getItem(TERMINAL_OPEN_KEY) === 'true'
}

/**
 * 终端会话管理 hook。
 *
 * 负责：终端创建/列表/销毁、WebSocket 连接生命周期、活动标签切换、面板高度。
 * 组件卸载时断开所有 WS（PTY 进程在后端保持存活，重连可恢复）。
 */
export function useTerminal() {
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [height, setHeight] = useState(loadHeight)
  const [open, setOpen] = useState(loadOpen)

  // ref 同步最新值供回调闭包使用
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  const updateSession = useCallback((id: string, patch: Partial<TerminalSession>) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }, [])

  /** 创建新终端会话并建立 WebSocket 连接。 */
  const createTerminal = useCallback(
    async (opts?: { cwd?: string; cols?: number; rows?: number; title?: string }) => {
      const info = await terminalAPI.create(opts)
      const session: TerminalSession = {
        ...info,
        ws: null,
        connecting: true,
      }
      setSessions((prev) => [...prev, session])
      setActiveId(info.id)
      return info.id
    },
    [],
  )

  /** 连接 WebSocket 到指定终端。 */
  const connect = useCallback(
    (id: string) => {
      const existing = sessionsRef.current.find((s) => s.id === id)
      if (!existing) return

      // 已连接或正在连接则跳过
      if (existing.ws && (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)) {
        return
      }

      updateSession(id, { connecting: true })

      const ws = new WebSocket(terminalWsUrl(id))

      ws.onopen = () => {
        updateSession(id, { ws, connecting: false })
      }

      ws.onclose = () => {
        updateSession(id, { ws: null, connecting: false })
      }

      ws.onerror = () => {
        updateSession(id, { ws: null, connecting: false })
      }

      // ws.onmessage 由 Terminal 组件注册（需要拿到原始数据）
    },
    [updateSession],
  )

  /** 断开 WebSocket（PTY 进程保持存活）。 */
  const disconnect = useCallback(
    (id: string) => {
      const session = sessionsRef.current.find((s) => s.id === id)
      if (session?.ws) {
        session.ws.close()
        updateSession(id, { ws: null })
      }
    },
    [updateSession],
  )

  /** 关闭终端会话（终止 PTY 进程 + 移除标签）。 */
  const closeTerminal = useCallback(
    async (id: string) => {
      const session = sessionsRef.current.find((s) => s.id === id)
      if (session?.ws) session.ws.close()

      try {
        await terminalAPI.kill(id)
      } catch {
        // PTY 可能已退出
      }

      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id)
        // 如果关闭的是活动标签，切换到最后一个
        if (activeId === id) {
          const last = next.length > 0 ? next[next.length - 1] : undefined
          setActiveId(last ? last.id : null)
        }
        return next
      })
    },
    [activeId],
  )

  /** 调整终端尺寸。 */
  const resize = useCallback(
    async (id: string, cols: number, rows: number) => {
      try {
        await terminalAPI.resize(id, cols, rows)
      } catch {
        // 终端可能已退出
      }
    },
    [],
  )

  /** 获取指定终端的 WebSocket（供 Terminal 组件注册 onmessage）。 */
  const getWebSocket = useCallback(
    (id: string): WebSocket | null => {
      return sessionsRef.current.find((s) => s.id === id)?.ws ?? null
    },
    [],
  )

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      localStorage.setItem(TERMINAL_OPEN_KEY, String(next))
      return next
    })
  }, [])

  const setHeightClamped = useCallback((h: number) => {
    const clamped = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h))
    setHeight(clamped)
    localStorage.setItem(TERMINAL_HEIGHT_KEY, String(clamped))
  }, [])

  // 卸载时断开所有 WebSocket（PTY 保持存活，可重连）
  useEffect(() => {
    return () => {
      for (const s of sessionsRef.current) {
        s.ws?.close()
      }
    }
  }, [])

  return {
    sessions,
    activeId,
    height,
    open,
    setActiveId,
    createTerminal,
    connect,
    disconnect,
    closeTerminal,
    resize,
    getWebSocket,
    toggleOpen,
    setHeight: setHeightClamped,
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
  }
}

export type UseTerminalReturn = ReturnType<typeof useTerminal>
