import { css } from '@linaria/core'
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MobileNav } from '../components/MobileNav.js'
import { DESKTOP, MOBILE } from '../styles/breakpoints.js'

// 三栏宽度常量：左 sidebar / 右 panel 各自可拖拽，中间 main flex 填充剩余空间。
const DEFAULT_SIDEBAR = 280
const MIN_SIDEBAR = 200
const MAX_SIDEBAR = 480
const DEFAULT_PANEL = 360
const MIN_PANEL = 240
const MAX_PANEL = 960
const SIDEBAR_KEY = 'c0de-agent:sidebarWidth'
const PANEL_KEY = 'c0de-agent:panelWidth'

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/** 从 localStorage 读取并钳制宽度；非法或缺省返回 fallback。 */
function loadWidth(key: string, fallback: number, min: number, max: number): number {
  const raw = localStorage.getItem(key)
  if (raw == null) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? clamp(n, min, max) : fallback
}

const layoutStyle = css`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  width: 100%;
`

const bodyStyle = css`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  ${DESKTOP} {
    flex-direction: row;
  }
`

const sidebarStyle = css`
  display: none;
  width: 100%;
  ${DESKTOP} {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
`

const mainStyle = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  ${MOBILE} {
    padding-bottom: 56px;
  }
`

const panelStyle = css`
  display: none;
  ${DESKTOP} {
    display: flex;
    flex-shrink: 0;
  }
`

// 分隔条：<hr> 语义即 separator，1px 视觉分隔线，::before 把可抓取热区扩展到 ±4px。
// 拖拽中/悬停高亮用 --primary；active 态额外通过 inline style 强化。
const resizerStyle = css`
  display: none;
  ${DESKTOP} {
    display: block;
    width: 1px;
    border: 0;
    margin: 0;
    cursor: col-resize;
    background: var(--border);
    flex-shrink: 0;
    position: relative;
    z-index: 5;
    transition: background 0.12s ease;
    &:hover {
      background: var(--primary);
    }
    &::before {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: -4px;
      right: -4px;
    }
  }
`

type LayoutProps = {
  header?: ReactNode
  sidebar?: ReactNode
  main: ReactNode
  panel?: ReactNode
}

/**
 * 水平拖拽调整列宽。dragging 为 true 时向 document 挂载 pointermove/up 监听，
 * 这样无论光标快速移出 1px 分隔条还是 setPointerCapture 在某些环境不可靠，
 * 都能稳定收到全部移动事件——比元素级 onPointerMove + 指针捕获更健壮。
 * applyDelta 用 ref 持有最新闭包，避免 effect 捕获旧值。
 */
function useColResize(applyDelta: (delta: number) => void) {
  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const applyRef = useRef(applyDelta)
  applyRef.current = applyDelta

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault()
    startX.current = e.clientX
    setDragging(true)
  }, [])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const delta = e.clientX - startX.current
      if (delta === 0) return
      startX.current = e.clientX
      applyRef.current(delta)
    }
    const onUp = () => setDragging(false)
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    // 拖拽中阻止 IFrames/其他元素抢占事件，并兼容部分浏览器丢失 pointerup 的边界
    const onDragEnd = () => setDragging(false)
    document.addEventListener('dragend', onDragEnd)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('dragend', onDragEnd)
    }
  }, [dragging])

  return { dragging, onPointerDown }
}

export function Layout({
  header: headerNode,
  sidebar: sidebarNode,
  main: mainNode,
  panel: panelNode,
}: LayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    loadWidth(SIDEBAR_KEY, DEFAULT_SIDEBAR, MIN_SIDEBAR, MAX_SIDEBAR),
  )
  const [panelWidth, setPanelWidth] = useState(() =>
    loadWidth(PANEL_KEY, DEFAULT_PANEL, MIN_PANEL, MAX_PANEL),
  )

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth))
  }, [sidebarWidth])
  useEffect(() => {
    localStorage.setItem(PANEL_KEY, String(panelWidth))
  }, [panelWidth])

  const sidebarResize = useColResize((delta) =>
    setSidebarWidth((w) => clamp(w + delta, MIN_SIDEBAR, MAX_SIDEBAR)),
  )
  const panelResize = useColResize((delta) =>
    setPanelWidth((w) => clamp(w - delta, MIN_PANEL, MAX_PANEL)),
  )

  const dragging = sidebarResize.dragging || panelResize.dragging
  useEffect(() => {
    if (!dragging) return
    const { cursor, userSelect } = document.body.style
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = cursor
      document.body.style.userSelect = userSelect
    }
  }, [dragging])

  return (
    <div className={layoutStyle}>
      {headerNode && <>{headerNode}</>}
      <div className={bodyStyle}>
        {sidebarNode && (
          <>
            <aside
              className={sidebarStyle}
              data-testid="layout-sidebar"
              style={{ width: sidebarWidth }}
            >
              {sidebarNode}
            </aside>
            <hr
              className={resizerStyle}
              data-testid="resizer-sidebar"
              aria-orientation="vertical"
              aria-label="调整侧边栏宽度"
              aria-valuenow={Math.round(sidebarWidth)}
              aria-valuemin={MIN_SIDEBAR}
              aria-valuemax={MAX_SIDEBAR}
              tabIndex={0}
              style={sidebarResize.dragging ? { background: 'var(--primary)' } : undefined}
              onPointerDown={sidebarResize.onPointerDown}
              onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR)}
            />
          </>
        )}
        <main className={mainStyle}>{mainNode}</main>
        {panelNode && (
          <>
            <hr
              className={resizerStyle}
              data-testid="resizer-panel"
              aria-orientation="vertical"
              aria-label="调整预览面板宽度"
              aria-valuenow={Math.round(panelWidth)}
              aria-valuemin={MIN_PANEL}
              aria-valuemax={MAX_PANEL}
              tabIndex={0}
              style={panelResize.dragging ? { background: 'var(--primary)' } : undefined}
              onPointerDown={panelResize.onPointerDown}
              onDoubleClick={() => setPanelWidth(DEFAULT_PANEL)}
            />
            <aside className={panelStyle} data-testid="layout-panel" style={{ width: panelWidth }}>
              {panelNode}
            </aside>
          </>
        )}
      </div>
      {/* 移动端底部导航栏（spec §10.3）；桌面端由组件内部隐藏 */}
      <MobileNav />
    </div>
  )
}
