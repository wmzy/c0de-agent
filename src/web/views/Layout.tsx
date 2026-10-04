import { css } from '@linaria/core'
import { Workbench } from 'haze-ui'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { useControl } from 'react-use-control'
import { MobileNav } from '@/components/MobileNav.js'
import { storageGet, storageSet } from '@/utils/storage.js'

// 侧栏宽度：Workbench 硬区间 160–480，产品下限保留 200。
const DEFAULT_SIDEBAR = 280
const MIN_SIDEBAR = 200
const MAX_SIDEBAR = 480
// 预览面板（auxiliaryBar）：Workbench 硬区间 180–480。
// 此前上限 960——Workbench 约束为 480，默认宽度取满 480。
const DEFAULT_PANEL = 480
const MIN_PANEL = 240
const MAX_PANEL = 480
const SIDEBAR_KEY = 'c0de-agent:sidebarWidth'
const PANEL_KEY = 'c0de-agent:panelWidth'

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/** 从 localStorage 读取并钳制宽度；非法或缺省返回 fallback。 */
function loadWidth(key: string, fallback: number, min: number, max: number): number {
  const raw = storageGet(key)
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

type LayoutProps = {
  header?: ReactNode
  /** 侧栏列（桌面端停靠；移动端经 MobileNav「会话」标签以覆盖层滑出）。 */
  sidebar?: ReactNode
  main: ReactNode
  /** 右侧辅助列（文件预览等）。 */
  panel?: ReactNode
  /** 底部终端面板：高度/折叠由 TerminalPanel 自管理，不进 Workbench 的
   *  panel 区——两套拖拽系统不能叠加在同一高度上。 */
  terminal?: ReactNode
}

/**
 * 应用主布局骨架（haze-ui Workbench）：
 * 侧栏 / 主区 / 辅助列三栏可拖拽（Workbench 内置 Resizable，
 * 分隔条含键盘可达的 role=separator）；列宽经 useControl 双向同步，
 * 拖拽提交即持久化到 localStorage。
 *
 * 移动端（<768px）：侧栏与辅助列变为滑出覆盖层（Escape 关闭、
 * 焦点管理内置），底部导航（MobileNav）经 tabBar 槽渲染。
 */
export function Layout({
  header: headerNode,
  sidebar: sidebarNode,
  main: mainNode,
  panel: panelNode,
  terminal: terminalNode,
}: LayoutProps) {
  // 列宽 control：Workbench 拖拽经 control setter 回写这里，
  // 变更即持久化；初始值从 localStorage 恢复。
  // useControl 首参是 Control | 初始值（不接受惰性函数——
  // 传函数会把 T 推断为 () => number，与 Control<number> 不兼容）。
  const [sidebarWidth, , sidebarWidthControl] = useControl(
    loadWidth(SIDEBAR_KEY, DEFAULT_SIDEBAR, MIN_SIDEBAR, MAX_SIDEBAR),
  )
  const [panelWidth, , panelWidthControl] = useControl(
    loadWidth(PANEL_KEY, DEFAULT_PANEL, MIN_PANEL, MAX_PANEL),
  )
  // 移动端侧栏覆盖层开闭（Workbench 内置滑出/遮罩/Esc/focus 管理）。
  const [mobileSidebarOpen, setMobileSidebarOpen, mobileSidebarOpenControl] = useControl(false)

  useEffect(() => {
    storageSet(SIDEBAR_KEY, String(sidebarWidth))
  }, [sidebarWidth])
  useEffect(() => {
    storageSet(PANEL_KEY, String(panelWidth))
  }, [panelWidth])

  return (
    <div className={layoutStyle}>
      {headerNode && <>{headerNode}</>}
      <Workbench
        // Workbench 根默认 height:100dvh；本布局是 appShell 内的 flex
        // 子项（上方还有 TopBar 等），改为 flex 填充剩余高度。
        style={{ height: 'auto', flex: '1 1 0%', minHeight: 0 }}
        sidebar={sidebarNode}
        sidebarWidth={sidebarWidthControl}
        auxiliaryBar={panelNode}
        auxiliaryBarWidth={panelWidthControl}
        mobileSidebarOpen={mobileSidebarOpenControl}
        tabBar={
          <MobileNav
            sidebar={sidebarNode}
            sessionsOpen={mobileSidebarOpen}
            onToggleSessions={() => setMobileSidebarOpen((open) => !open)}
            onSessionsClosed={() => setMobileSidebarOpen(false)}
          />
        }
      >
        {mainNode}
      </Workbench>
      {terminalNode}
    </div>
  )
}
