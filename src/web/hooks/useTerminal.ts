// src/web/hooks/useTerminal.ts

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { terminalAPI, terminalWsUrl, type TerminalInfo } from '../services/terminal.js'

export interface TerminalSession extends TerminalInfo {
  /** WebSocket 连接（null = 未连接/已断开）。 */
  ws: WebSocket | null
  /** 是否正在连接中。 */
  connecting: boolean
  /** 所属标签 id（同一 tabId 的终端共享一个标签页，实现分屏）。 */
  tabId: string
}

/** 分屏方向。 */
export type SplitDirection = 'horizontal' | 'vertical'

/** 单个标签的分屏布局信息。 */
export interface TabSplit {
  direction: SplitDirection
  /** 各 pane 的 flex-grow 比例，长度 = pane 数量，和无需归一化。 */
  sizes: number[]
}

/** 标签页：包含若干终端 pane 和分屏布局。 */
export interface TerminalTab {
  id: string
  panes: TerminalSession[]
  split: TabSplit
}

const TERMINAL_HEIGHT_KEY = 'c0de-agent:terminalHeight'
const TERMINAL_OPEN_KEY = 'c0de-agent:terminalOpen'
const TERMINAL_SESSIONS_KEY = 'c0de-agent:terminalSessions'
const DEFAULT_HEIGHT = 240
const MIN_HEIGHT = 100
const MAX_HEIGHT = 800

/** 持久化到 localStorage 的最小终端结构（不含 WS 对象）。 */
interface PersistedTerminalState {
  sessions: Array<{ id: string; tabId: string }>
  tabSplits: Record<string, TabSplit>
  activeTabId: string | null
  activePaneId: string | null
}

/** pane 最小 flex 比例（防止被拖到 0）。 */
const MIN_PANE_FLEX = 0.15

function loadHeight(): number {
  const raw = localStorage.getItem(TERMINAL_HEIGHT_KEY)
  if (raw == null) return DEFAULT_HEIGHT
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, n)) : DEFAULT_HEIGHT
}

function loadOpen(): boolean {
  return localStorage.getItem(TERMINAL_OPEN_KEY) === 'true'
}

function loadPersistedState(): PersistedTerminalState | null {
  try {
    const raw = localStorage.getItem(TERMINAL_SESSIONS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedTerminalState
    if (!parsed?.sessions || !Array.isArray(parsed.sessions)) return null
    return parsed
  } catch {
    return null
  }
}

function savePersistedState(state: PersistedTerminalState): void {
  try {
    localStorage.setItem(TERMINAL_SESSIONS_KEY, JSON.stringify(state))
  } catch {
    // localStorage 满或不可用，忽略
  }
}

/**
 * 终端会话管理 hook（支持 VSCode 风格分屏）。
 *
 * 负责：终端创建/列表/销毁、WebSocket 连接生命周期、标签切换、
 * 分屏（split）方向与 pane 尺寸、面板高度。
 *
 * 数据模型：
 * - sessions 为扁平列表，每个 session 有 tabId 标识所属标签
 * - tabs 由 sessions 按 tabId 分组派生
 * - 每个 tab 维护 split（direction + sizes）
 * - activeTabId / activePaneId 分别追踪当前标签和 pane
 *
 * 组件卸载时断开所有 WS（PTY 进程在后端保持存活，重连可恢复）。
 */
export function useTerminal() {
  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [tabSplits, setTabSplits] = useState<Record<string, TabSplit>>({})
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [activePaneId, setActivePaneId] = useState<string | null>(null)
  const [height, setHeight] = useState(loadHeight)
  const [open, setOpen] = useState(loadOpen)
  /** 页面加载时恢复终端会话，恢复期间阻止自动创建。 */
  const [restoring, setRestoring] = useState(true)

  // ref 同步最新值供回调闭包使用
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  const activePaneIdRef = useRef(activePaneId)
  activePaneIdRef.current = activePaneId
  const tabSplitsRef = useRef(tabSplits)
  tabSplitsRef.current = tabSplits

  /** 派生 tabs：按 tabId 分组。 */
  const tabs: TerminalTab[] = useMemo(() => {
    const map = new Map<string, TerminalSession[]>()
    for (const s of sessions) {
      const list = map.get(s.tabId)
      if (list) {
        list.push(s)
      } else {
        map.set(s.tabId, [s])
      }
    }
    const result: TerminalTab[] = []
    for (const [tabId, panes] of map) {
      const split = tabSplitsRef.current[tabId] ?? {
        direction: 'horizontal' as SplitDirection,
        sizes: [1],
      }
      // 确保 sizes 长度与 pane 数量一致
      const sizes = reconcileSizes(split.sizes, panes.length)
      result.push({ id: tabId, panes, split: { direction: split.direction, sizes } })
    }
    return result
  }, [sessions, tabSplits])

  const updateSession = useCallback((id: string, patch: Partial<TerminalSession>) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }, [])

  /** 创建新终端会话（作为新标签页）。建立 WebSocket 连接。 */
  const createTerminal = useCallback(
    async (opts?: { cwd?: string; cols?: number; rows?: number; title?: string }) => {
      const info = await terminalAPI.create(opts)
      const tabId = info.id // 新终端独占一个标签
      const session: TerminalSession = {
        ...info,
        ws: null,
        connecting: false,
        tabId,
      }
      setSessions((prev) => [...prev, session])
      setTabSplits((prev) => ({ ...prev, [tabId]: { direction: 'horizontal', sizes: [1] } }))
      setActiveTabId(tabId)
      setActivePaneId(info.id)
      return info.id
    },
    [],
  )

  /** 在当前标签内分屏：创建新终端 pane 加入当前标签的分屏。 */
  const splitTerminal = useCallback(
    async (opts?: { cwd?: string; direction?: SplitDirection }) => {
      const tabId = activeTabIdRef.current
      if (!tabId) return undefined

      // 获取当前 tab 的 pane 数
      const tabPanes = sessionsRef.current.filter((s) => s.tabId === tabId)
      if (tabPanes.length === 0) return undefined

      const info = await terminalAPI.create(opts)
      const session: TerminalSession = {
        ...info,
        ws: null,
        connecting: false,
        tabId,
      }
      setSessions((prev) => [...prev, session])

      // 更新分屏布局
      setTabSplits((prev) => {
        const existing = prev[tabId] ?? { direction: 'horizontal' as SplitDirection, sizes: [1] }
        const direction = opts?.direction ?? existing.direction
        // 新 pane 取平均份额
        const oldSizes = reconcileSizes(existing.sizes, tabPanes.length)
        const newSizes = [...oldSizes.map((s) => s * 0.5), 0.5]
        return { ...prev, [tabId]: { direction, sizes: newSizes } }
      })

      setActivePaneId(info.id)
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

  /** 关闭终端 pane（终止 PTY 进程 + 移除）。若为标签内最后一个 pane 则关闭整个标签。 */
  const closeTerminal = useCallback(
    async (id: string) => {
      const session = sessionsRef.current.find((s) => s.id === id)
      if (session?.ws) session.ws.close()

      try {
        await terminalAPI.kill(id)
      } catch {
        // PTY 可能已退出
      }

      const tabId = session?.tabId
      // 在 setSessions 之前计算 idx 和 remainingInTab，
      // 避免 functional update 内 sessionsRef.current 已被其他 re-render 更新导致 idx=-1
      const tabPanes = sessionsRef.current.filter((s) => s.tabId === tabId)
      const idx = tabPanes.findIndex((s) => s.id === id)
      const remainingInTab = tabPanes.length - 1

      setSessions((prev) => prev.filter((s) => s.id !== id))

      // 更新分屏 sizes
      if (tabId && remainingInTab > 0) {
        setTabSplits((prev) => {
          const existing = prev[tabId]
          if (!existing) return prev
          const newSizes = existing.sizes.filter((_, i) => i !== idx)
          return { ...prev, [tabId]: { ...existing, sizes: reconcileSizes(newSizes, remainingInTab) } }
        })
      } else if (tabId) {
        // 标签内没有 pane 了，清理 split 信息
        setTabSplits((prev) => {
          const next = { ...prev }
          delete next[tabId]
          return next
        })
      }

      // 如果关闭的是活动 pane，切换到同标签内其他 pane
      if (activePaneIdRef.current === id) {
        if (tabId && remainingInTab > 0) {
          const siblings = sessionsRef.current.filter((s) => s.tabId === tabId && s.id !== id)
          const last = siblings[siblings.length - 1]
          setActivePaneId(last ? last.id : null)
        } else {
          // 标签关闭，切换到最后一个标签
          setActivePaneId(null)
          // 更新活动标签
          const otherTabs = sessionsRef.current
            .filter((s) => s.tabId !== tabId)
            .map((s) => s.tabId)
          const uniqueTabs = [...new Set(otherTabs)]
          setActiveTabId(uniqueTabs.length > 0 ? uniqueTabs[uniqueTabs.length - 1]! : null)
        }
      }
    },
    [],
  )

  /** 调整终端尺寸（PTY cols/rows）。 */
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

  /** 切换标签的分屏方向。 */
  const setSplitDirection = useCallback(
    (tabId: string, direction: SplitDirection) => {
      setTabSplits((prev) => {
        const existing = prev[tabId] ?? { direction, sizes: [1] }
        return { ...prev, [tabId]: { ...existing, direction } }
      })
    },
    [],
  )

  /** 更新标签内 pane 的尺寸比例（拖拽分隔条后调用）。 */
  const setPaneSizes = useCallback(
    (tabId: string, sizes: number[]) => {
      setTabSplits((prev) => {
        const existing = prev[tabId] ?? { direction: 'horizontal' as SplitDirection, sizes }
        return { ...prev, [tabId]: { ...existing, sizes } }
      })
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

  // ---- 恢复：页面加载时从后端获取存活 PTY 列表，结合 localStorage 恢复 tab/pane 结构 ----
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const persisted = loadPersistedState()
      if (!persisted?.sessions.length) {
        setRestoring(false)
        return
      }
      try {
        const { terminals } = await terminalAPI.list()
        if (cancelled) return
        const liveIds = new Set(terminals.map((t) => t.id))
        // 过滤掉已死的 PTY，保留存活且在 localStorage 中的
        const restored = persisted.sessions
          .filter((ps) => liveIds.has(ps.id))
          .map((ps) => {
            const info = terminals.find((t) => t.id === ps.id)!
            return {
              ...info,
              ws: null,
              connecting: false,
              tabId: ps.tabId,
            } satisfies TerminalSession
          })
        if (restored.length === 0) {
          setRestoring(false)
          return
        }
        // 重建 tabSplits，只保留仍有 pane 的 tab
        const liveTabIds = new Set(restored.map((s) => s.tabId))
        const restoredSplits: Record<string, TabSplit> = {}
        for (const [tabId, split] of Object.entries(persisted.tabSplits)) {
          if (liveTabIds.has(tabId)) {
            const paneCount = restored.filter((s) => s.tabId === tabId).length
            restoredSplits[tabId] = {
              direction: split.direction,
              sizes: reconcileSizes(split.sizes, paneCount),
            }
          }
        }
        setSessions(restored)
        setTabSplits(restoredSplits)

        // 恢复 activeTabId / activePaneId，无效则回退到第一个
        const validTabId =
          persisted.activeTabId && liveTabIds.has(persisted.activeTabId)
            ? persisted.activeTabId
            : restored[0]!.tabId
        const validPaneId =
          persisted.activePaneId && restored.some((s) => s.id === persisted.activePaneId)
            ? persisted.activePaneId
            : restored.find((s) => s.tabId === validTabId)?.id ?? null
        setActiveTabId(validTabId)
        setActivePaneId(validPaneId)
      } catch {
        // 后端不可用，不恢复任何会话
      } finally {
        if (!cancelled) setRestoring(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // ---- 持久化：sessions/tabSplits/active 变化时写入 localStorage ----
  useEffect(() => {
    if (restoring) return
    savePersistedState({
      sessions: sessions.map((s) => ({ id: s.id, tabId: s.tabId })),
      tabSplits,
      activeTabId,
      activePaneId,
    })
  }, [restoring, sessions, tabSplits, activeTabId, activePaneId])

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
    tabs,
    activeTabId,
    activePaneId,
    height,
    open,
    restoring,
    setActiveTabId,
    setActivePaneId,
    createTerminal,
    splitTerminal,
    connect,
    disconnect,
    closeTerminal,
    resize,
    getWebSocket,
    setSplitDirection,
    setPaneSizes,
    toggleOpen,
    setHeight: setHeightClamped,
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
    minPaneFlex: MIN_PANE_FLEX,
  }
}

export type UseTerminalReturn = ReturnType<typeof useTerminal>

/** 确保 sizes 数组长度与 pane 数量一致，且归一化为均值 1.0。
 *  归一化后每个 pane 的 flex-grow ≈ 1.0，浏览器会正确分配空间。
 *  不归一化时（如 [0.5]），单个 pane 的 flex-grow:0.5 只占 50% 而非 100%。 */
function reconcileSizes(sizes: number[], count: number): number[] {
  let arr: number[]
  if (sizes.length === count) {
    arr = sizes
  } else if (sizes.length > count) {
    arr = sizes.slice(0, count)
  } else {
    arr = [...sizes, ...Array(count - sizes.length).fill(1)]
  }
  // 归一化：使总和 = count（均值 1.0）
  const sum = arr.reduce((a, b) => a + b, 0)
  if (sum <= 0) return arr.map(() => 1)
  return arr.map((s) => (s * count) / sum)
}
