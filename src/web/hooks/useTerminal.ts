// src/web/hooks/useTerminal.ts

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  loadHeight,
  loadOpen,
  loadPersistedState,
  MAX_HEIGHT,
  MIN_HEIGHT,
  MIN_PANE_FLEX,
  openKey,
  reconcileSizes,
  savePersistedState,
  TERMINAL_HEIGHT_KEY,
} from '@/hooks/terminal-persistence.js'
import { type TerminalInfo, terminalAPI, terminalWsUrl } from '@/services/terminal.js'
import { storageSet } from '@/utils/storage.js'

export interface TerminalSession extends TerminalInfo {
  /** WebSocket 连接（null = 未连接/已断开）。 */
  ws: WebSocket | null
  /** 是否正在连接中（含断线后的退避重连等待期）。 */
  connecting: boolean
  /** 所属标签 id（同一 tabId 的终端共享一个标签页，实现分屏）。 */
  tabId: string
  /**
   * 连接终态：PTY 已退出（'exited'）或服务端拒绝挂载/重连耗尽（'unreachable'）。
   * 终态下不再自动重连——PTY 已经不存在，重连永远不会成功。
   */
  dead?: 'exited' | 'unreachable'
  /** PTY 退出码（dead === 'exited' 时有效）。 */
  exitCode?: number
}

/** 分屏方向。 */
export type SplitDirection = 'horizontal' | 'vertical'

/** 断线重连策略：指数退避，次数耗尽后判死。 */
const MAX_RETRY = 6
const RETRY_BASE_MS = 500
const RETRY_CAP_MS = 8_000
/** 视为「连稳」的时长：不足这个时间的连接不算恢复，退避不清零。 */
const STABLE_MS = 5_000

/** 单个 pane 的重连账本（不进 state：连接节奏不该触发任何重渲染）。 */
interface ConnState {
  /** 已重试次数。 */
  attempts: number
  /** 下一次允许重连的时间戳（退避窗口内外部的自动重连一律忽略）。 */
  nextAt: number
  /** 退避计时器。 */
  timer: ReturnType<typeof setTimeout> | null
  /** 已判死：此后不再接受任何自动重连。 */
  stopped: boolean
}

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
export function useTerminal(projectId: string) {
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId

  const [sessions, setSessions] = useState<TerminalSession[]>([])
  const [tabSplits, setTabSplits] = useState<Record<string, TabSplit>>({})
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [activePaneId, setActivePaneId] = useState<string | null>(null)
  const [height, setHeight] = useState(loadHeight)
  const [open, setOpen] = useState(() => loadOpen(projectId))
  /** open 镜像：toggleOpen 在状态更新器外读取当前值并落盘。 */
  const openRef = useRef(open)
  openRef.current = open
  /** 页面加载时恢复终端会话，恢复期间阻止自动创建。 */
  const [restoring, setRestoring] = useState(true)

  // ref 同步最新值供回调闭包使用
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  const activePaneIdRef = useRef(activePaneId)
  activePaneIdRef.current = activePaneId

  /** 派生 tabs：按 tabId 分组。
   *  tabSplits 必须进依赖：此前 memo 只依赖 sessions、经 tabSplitsRef 读取
   *  分屏状态——setPaneSizes/setSplitDirection 触发的重渲染命中 memo 缓存，
   *  UI（PaneSplitContainer 的 flexGrow / direction）永远拿不到新值：
   *  拖拽分隔条/键盘调整/切换分屏方向全部无视觉反馈（直到某次 sessions 变化
   *  才顺带刷新）。 */
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
      const split = tabSplits[tabId] ?? {
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

  // ---- 连接生命周期账本（ref：连接节奏不参与渲染） ----
  /** 每 pane 的重连状态。 */
  const connRef = useRef(new Map<string, ConnState>())
  /** 主动关闭的 socket：其 onclose 不触发重连（切项目/卸载/关闭 pane，PTY 仍在）。 */
  const intentionalClose = useRef(new WeakSet<WebSocket>())
  /** 已关闭过的 socket：同一次断线只按第一次事件计账。 */
  const closedOnce = useRef(new WeakSet<WebSocket>())
  /** 握手成功时刻：用于区分「连稳了」与「刚连上就被掐」（前者才清零退避）。 */
  const openedAt = useRef(new WeakMap<WebSocket, number>())
  /** hook 已卸载：卸载后的迟到事件不得再发起连接或定时器。 */
  const disposedRef = useRef(false)
  /** connect 自身引用（重连定时器回调里取最新实现）。 */
  const connectRef = useRef<(id: string) => void>(() => {})

  /** 清掉某 pane 的重连账本与计时器。 */
  const clearConn = useCallback((id: string) => {
    const st = connRef.current.get(id)
    if (st?.timer) clearTimeout(st.timer)
    connRef.current.delete(id)
  }, [])

  /**
   * 标记 pane 终态：PTY 已退出 / 服务端拒绝挂载 / 重连耗尽。
   * 终态同步进 ref 与 state 两条线——ref 供 connect 立即判停（onclose 往往早于
   * React 提交 state，state 里读到旧值又会重开一轮）。
   */
  const markDead = useCallback(
    (id: string, dead: 'exited' | 'unreachable', exitCode?: number) => {
      clearConn(id)
      connRef.current.set(id, { attempts: 0, nextAt: 0, timer: null, stopped: true })
      updateSession(id, { dead, exitCode, ws: null, connecting: false })
    },
    [clearConn, updateSession],
  )

  /** 创建新终端会话（作为新标签页）。建立 WebSocket 连接。 */
  const createTerminal = useCallback(
    async (opts?: { cwd?: string; cols?: number; rows?: number; title?: string }) => {
      const info = await terminalAPI.create({ ...opts, projectId: projectIdRef.current })
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
  const splitTerminal = useCallback(async (opts?: { cwd?: string; direction?: SplitDirection }) => {
    const tabId = activeTabIdRef.current
    if (!tabId) return undefined

    // 获取当前 tab 的 pane 数
    const tabPanes = sessionsRef.current.filter((s) => s.tabId === tabId)
    if (tabPanes.length === 0) return undefined

    const info = await terminalAPI.create({ ...opts, projectId: projectIdRef.current })
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
  }, [])

  /** 主动关闭 socket：标记后其 onclose 不触发重连。 */
  const closeSocket = useCallback((ws: WebSocket | null) => {
    if (!ws) return
    intentionalClose.current.add(ws)
    ws.close()
  }, [])

  /**
   * socket 断开后的处置：主动关闭 → 什么都不做；终态 → 不重连；服务端明确
   * 拒绝挂载（1008 Terminal not found，PTY 已不存在）→ 直接判死；其余断线
   * （网络抖动、服务重启）→ 指数退避重连，次数耗尽判死。
   */
  const handleSocketClosed = useCallback(
    (ws: WebSocket, id: string, code: number) => {
      if (closedOnce.current.has(ws)) return
      closedOnce.current.add(ws)
      if (intentionalClose.current.has(ws)) return
      if (disposedRef.current) return
      const st = connRef.current.get(id)
      if (st?.stopped) return
      if (code === 1008) {
        markDead(id, 'unreachable')
        return
      }
      // 只认「连稳过」的连接：连上不足 5 秒就断的抖动链路不清零，
      // 否则每次重连都把退避打回第一档，退避上限形同虚设。
      const wasStable = Date.now() - (openedAt.current.get(ws) ?? 0) >= STABLE_MS
      const attempts = (wasStable ? 0 : (st?.attempts ?? 0)) + 1
      if (attempts > MAX_RETRY) {
        markDead(id, 'unreachable')
        return
      }
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_CAP_MS)
      if (st?.timer) clearTimeout(st.timer)
      const next: ConnState = { attempts, nextAt: Date.now() + delay, timer: null, stopped: false }
      next.timer = setTimeout(() => {
        next.timer = null
        connectRef.current(id)
      }, delay)
      connRef.current.set(id, next)
      // 退避期间保持 connecting：pane 据此显示「正在重连…」，
      // TerminalPanel 的自动重连 effect 也不会再来抢跑（tabs 每次变化都重跑它）。
      updateSession(id, { ws: null, connecting: true })
    },
    [markDead, updateSession],
  )

  /** 连接 WebSocket 到指定终端。 */
  const connect = useCallback(
    (id: string) => {
      const existing = sessionsRef.current.find((s) => s.id === id)
      if (!existing) return
      // 终态：PTY 已不存在，重连永远不会成功（此前会无延迟地反复重连，
      // 服务端每秒被打进几十次 WS upgrade，pane 永远黑屏且没有任何提示）。
      if (existing.dead) return
      const st = connRef.current.get(id)
      if (st?.stopped) return
      // 退避窗口内不重开 socket。
      if (st && Date.now() < st.nextAt) return

      // 已连接或正在连接则跳过
      if (
        existing.ws &&
        (existing.ws.readyState === WebSocket.OPEN ||
          existing.ws.readyState === WebSocket.CONNECTING)
      ) {
        return
      }

      updateSession(id, { connecting: true })

      const ws = new WebSocket(terminalWsUrl(id))

      // 早期消息缓冲：后端在 WS 连接时立即回放 scrollback，
      // 但此时 Terminal 组件尚未注册 onmessage（React effect 延迟一个渲染周期）。
      // 先用 onmessage 暂存消息，Terminal effect 清空缓冲后切换到正式处理器。
      const earlyData: string[] = []
      ws.onmessage = (ev: MessageEvent) => {
        const data = typeof ev.data === 'string' ? ev.data : ev.data.toString('utf8')
        earlyData.push(data)
      }
      ;(ws as WebSocket & { __earlyData?: string[] }).__earlyData = earlyData

      ws.onopen = () => {
        // 只记连上的时刻，不在此清零退避计数：退避是否清零要看「这次连接稳了
        // 没有」，只有断开那一刻才知道（见 handleSocketClosed 的 wasStable）。
        openedAt.current.set(ws, Date.now())
        updateSession(id, { ws, connecting: false })
      }

      // 只挂 onclose：连接失败时浏览器必定补一个 close 事件（close event 的
      // code 才是判据——1008 = 服务端拒绝挂载，PTY 已不存在）。onerror 不会给出
      // 可用信息，两个事件都记账会把同一次断线算成两次。
      ws.onclose = (ev: CloseEvent) => {
        handleSocketClosed(ws, id, ev?.code ?? 1006)
      }

      // ws.onmessage 由 Terminal 组件注册（需要拿到原始数据）
    },
    [handleSocketClosed, updateSession],
  )
  connectRef.current = connect

  /** 断开 WebSocket（PTY 进程保持存活）。 */
  const disconnect = useCallback(
    (id: string) => {
      const session = sessionsRef.current.find((s) => s.id === id)
      if (session?.ws) {
        clearConn(id)
        closeSocket(session.ws)
        updateSession(id, { ws: null })
      }
    },
    [clearConn, closeSocket, updateSession],
  )

  /** 关闭终端 pane（终止 PTY 进程 + 移除）。若为标签内最后一个 pane 则关闭整个标签。 */
  const closeTerminal = useCallback(
    async (id: string) => {
      const session = sessionsRef.current.find((s) => s.id === id)
      clearConn(id)
      closeSocket(session?.ws ?? null)

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
          return {
            ...prev,
            [tabId]: { ...existing, sizes: reconcileSizes(newSizes, remainingInTab) },
          }
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
          const otherTabs = sessionsRef.current.filter((s) => s.tabId !== tabId).map((s) => s.tabId)
          const uniqueTabs = [...new Set(otherTabs)]
          setActiveTabId(uniqueTabs.length > 0 ? (uniqueTabs[uniqueTabs.length - 1] ?? null) : null)
        }
      }
    },
    [clearConn, closeSocket],
  )

  /** 调整终端尺寸（PTY cols/rows）。 */
  const resize = useCallback(async (id: string, cols: number, rows: number) => {
    try {
      await terminalAPI.resize(id, cols, rows)
    } catch {
      // 终端可能已退出
    }
  }, [])

  /** 获取指定终端的 WebSocket（供 Terminal 组件注册 onmessage）。 */
  const getWebSocket = useCallback((id: string): WebSocket | null => {
    return sessionsRef.current.find((s) => s.id === id)?.ws ?? null
  }, [])

  /** 切换标签的分屏方向。 */
  const setSplitDirection = useCallback((tabId: string, direction: SplitDirection) => {
    setTabSplits((prev) => {
      const existing = prev[tabId] ?? { direction, sizes: [1] }
      return { ...prev, [tabId]: { ...existing, direction } }
    })
  }, [])

  /** 更新标签内 pane 的尺寸比例（拖拽分隔条后调用）。 */
  const setPaneSizes = useCallback((tabId: string, sizes: number[]) => {
    setTabSplits((prev) => {
      const existing = prev[tabId] ?? { direction: 'horizontal' as SplitDirection, sizes }
      return { ...prev, [tabId]: { ...existing, sizes } }
    })
  }, [])

  const toggleOpen = useCallback(() => {
    // 持久化在更新器之外：状态更新器必须是纯函数（StrictMode/并发渲染会重放），
    // 且回读最新值以支持连续切换。
    setOpen((prev) => !prev)
    const next = !openRef.current
    // 存储不可用（隐私模式/配额）时降级：面板开关仅本次会话有效
    storageSet(openKey(projectIdRef.current), String(next))
  }, [])

  const setHeightClamped = useCallback((h: number) => {
    const clamped = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h))
    setHeight(clamped)
    storageSet(TERMINAL_HEIGHT_KEY, String(clamped))
  }, [])
  // ---- 恢复：projectId 变化时按项目重建终端结构 ----
  useEffect(() => {
    const pid = projectId
    let cancelled = false
    setRestoring(true)
    // 断开当前所有 WebSocket（PTY 在后端保持存活，切回可重连）
    for (const s of sessionsRef.current) {
      clearConn(s.id)
      closeSocket(s.ws)
    }
    // 清空当前项目状态
    setSessions([])
    setTabSplits({})
    setActiveTabId(null)
    setActivePaneId(null)
    // 恢复该项目的面板开关状态（无记录默认关闭）
    setOpen(loadOpen(pid))

    void (async () => {
      const persisted = loadPersistedState(pid)
      if (!persisted?.sessions.length) {
        if (!cancelled) setRestoring(false)
        return
      }
      try {
        const { terminals } = await terminalAPI.list()
        if (cancelled) return
        // 后端 projectId 为权威：仅归属当前项目的存活 PTY
        const liveIds = new Set(terminals.filter((t) => t.projectId === pid).map((t) => t.id))
        const restored = persisted.sessions
          .filter((ps) => liveIds.has(ps.id))
          .map((ps): TerminalSession | null => {
            const info = terminals.find((t) => t.id === ps.id)
            if (!info) return null
            return {
              ...info,
              ws: null,
              connecting: false,
              tabId: ps.tabId,
            }
          })
          .filter((s): s is TerminalSession => s !== null)
        if (restored.length === 0) {
          if (!cancelled) setRestoring(false)
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
            : (restored[0]?.tabId ?? null)
        const validPaneId =
          persisted.activePaneId && restored.some((s) => s.id === persisted.activePaneId)
            ? persisted.activePaneId
            : (restored.find((s) => s.tabId === validTabId)?.id ?? null)
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
  }, [projectId, clearConn, closeSocket])

  // ---- 持久化：sessions/tabSplits/active 变化时写入 localStorage ----
  useEffect(() => {
    if (restoring) return
    savePersistedState(
      {
        sessions: sessions.map((s) => ({ id: s.id, tabId: s.tabId })),
        tabSplits,
        activeTabId,
        activePaneId,
      },
      projectIdRef.current,
    )
  }, [restoring, sessions, tabSplits, activeTabId, activePaneId])

  // 卸载时断开所有 WebSocket（PTY 保持存活，可重连）并停掉重连节奏：
  // 否则退避定时器会在 hook 之外回调 connect，发出无人接管的 WS。
  // disposedRef 在挂载时复位：StrictMode 的「挂载 → 清理 → 再挂载」走的是同一个
  // 实例（ref 存活），不复位会让重连被自己的清理永久判停。
  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      for (const st of connRef.current.values()) {
        if (st.timer) clearTimeout(st.timer)
      }
      connRef.current.clear()
      for (const s of sessionsRef.current) {
        closeSocket(s.ws)
      }
    }
  }, [closeSocket])

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
    markDead,
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
