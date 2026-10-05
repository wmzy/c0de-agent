// src/web/components/TerminalPanel.tsx

import { css } from '@linaria/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PaneSplitContainer } from '@/components/PaneSplitContainer.js'
import type { SplitDirection, UseTerminalReturn } from '@/hooks/useTerminal.js'
import { lockBodyCursor, restoreBodyCursor } from '@/utils/drag-cursor.js'

interface TerminalPanelProps {
  terminal: UseTerminalReturn
  /** 新终端的默认工作目录（通常为项目 worktree）。未提供时使用服务端默认。 */
  cwd?: string
}

// 面板外层：flex-shrink 允许在视口高度不足时收缩（正常 900px 视口无赤字、不影响布局），
// min-height 兜底保证标签工具栏（36px 头 + 边框）永远不会被整行裁掉。
const panelStyle = css`
  display: flex;
  flex-direction: column;
  flex-shrink: 1;
  min-height: 40px;
  background: #0d1117;
  border-top: 1px solid var(--haze-color-border);
  overflow: hidden;
`

const headerStyle = css`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  height: 36px;
  flex-shrink: 0;
  background: var(--haze-color-bg-subtle);
  border-bottom: 1px solid var(--haze-color-border);
  user-select: none;
`

const tabsStyle = css`
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;

  &::-webkit-scrollbar {
    height: 3px;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--haze-color-border);
    border-radius: 2px;
  }
`

/**
 * 标签外壳：视觉上的「药丸」（背景/边框/圆角/hover/内边距都在这一层）。
 *
 * 之所以把样式从 role="tab" 元素本身挪到外层壳：关闭按钮此前是 role="tab"
 * 的**后代**（axe nested-interactive serious，WCAG 4.1.2 名不副实）——
 * tab 角色要求「选中即切换标签」，读屏会播报一个既非标签又非按钮的嵌套控件，
 * 且 tab 内可聚焦后代让「标签只占一个 Tab 停靠点」的 tablist 约定失效：
 * 实测键盘 Tab 到标签后下一停直接落到里面的「关闭终端标签」按钮上。
 *
 * 现在壳（role=presentation，只管视觉与点击）→ [role=tab 标签文本] +
 * [关闭按钮] 平级。关闭按钮仍是壳的子元素，hover/点击行为与几何完全不变，
 * 点击关闭钮 e.stopPropagation() 已在 handleCloseTab 里，不会误触发切标签。
 */
const tabWrapStyle = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s, color 0.1s;

  &:hover {
    background: var(--haze-color-bg);
    color: var(--haze-color-text);
  }
`

/**
 * 标签切换按钮：只装标签文本与分屏数徽标。
 *
 * 从 div 改成 button 后要显式清掉控件默认外观：全局 `:where(button)` 与
 * haze 控件基线给裸按钮加了 padding:8px 12px / min-height:44px，36px 高的
 * 标签栏里直接溢出（实测标签壳 46px vs 标签栏 36px，药丸被裁掉上下边缘）。
 * 这里把 padding/min-height/边框底色全部归零，高度由外壳的 flex 决定；
 * 背景与颜色继承外壳，hover 效果仍在外壳上。
 */
const tabStyle = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
  min-height: auto;
`

const tabActiveStyle = css`
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  border-color: var(--haze-color-border);
`

const tabBadgeStyle = css`
  font-size: 10px;
  background: var(--haze-color-border);
  color: var(--haze-color-text);
  border-radius: 3px;
  padding: 0 4px;
  line-height: 16px;
  min-width: 16px;
  text-align: center;
`

const tabCloseStyle = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: var(--haze-color-text-secondary);
  font-size: 14px;
  cursor: pointer;
  border-radius: 3px;
  padding: 0;
  line-height: 1;
  /* 覆盖全局 button 的 44px 触控最小尺寸，否则 16px 关闭钮被撑大溢出标签行 */
  min-height: auto;
  min-width: auto;

  &:hover {
    background: var(--haze-color-danger);
    color: #fff;
  }
`

const iconBtnStyle = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--haze-color-text-secondary);
  font-size: 15px;
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;
  /* 覆盖全局 button 的 44px 触控最小尺寸，保持 36px 工具栏行内的紧凑图标钮 */
  min-height: auto;
  min-width: auto;

  &:hover {
    background: var(--haze-color-bg);
    color: var(--haze-color-text);
  }

  &:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
`

const closePanelBtnStyle = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--haze-color-text-secondary);
  font-size: 16px;
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;
  /* 覆盖全局 button 的 44px 触控最小尺寸，保持 36px 工具栏行内的紧凑图标钮 */
  min-height: auto;
  min-width: auto;

  &:hover {
    background: var(--haze-color-danger);
    color: #fff;
  }
`

const termAreaStyle = css`
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  display: flex;
`

const resizeHandleStyle = css`
  height: 4px;
  cursor: row-resize;
  background: var(--haze-color-border);
  flex-shrink: 0;
  transition: background 0.12s;
  border: none;
  padding: 0;
  margin: 0;

  &:hover {
    background: var(--haze-color-primary);
  }
`

const connectingStyle = css`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--haze-color-text-secondary);
  font-size: 13px;
`

/** 从 shell 路径提取短名称用于标签显示。 */
function shellLabel(shell: string): string {
  const base = shell.split('/').pop() ?? shell
  return base
}

/**
 * 终端面板：底部可拖拽调整高度的容器，支持多标签页和 VSCode 风格分屏。
 *
 * - 标签栏：切换 / 新建(+) / 关闭(×)
 * - 分屏：split 按钮在当前标签内创建新 pane（水平/垂直方向）
 * - pane 间可拖拽分隔条调整大小
 * - 高度拖拽：上拉/下拉调整，记忆到 localStorage
 * - 隐藏时整块 display:none（仅显示拖拽条），避免隐藏控件排布到视口外仍可聚焦
 */
export function TerminalPanel({ terminal, cwd }: TerminalPanelProps) {
  const {
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
    closeTerminal,
    resize,
    getWebSocket,
    setSplitDirection,
    setPaneSizes,
    toggleOpen,
    setHeight,
    minPaneFlex,
  } = terminal

  const draggingRef = useRef(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(0)
  const [dragging, setDragging] = useState(false)

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  // 面板打开时自动创建首个终端（等待项目目录 cwd 就绪后再创建，
  // 避免在进程启动目录而非项目目录打开 shell）。
  // 仅在本轮「打开」周期内创建一次：用户主动关掉最后一个标签后不重建。
  const autoCreatedRef = useRef(false)
  // 标签切换按钮的 DOM 引用：toolbar 内方向键切换活动标签时同步移动焦点，
  // 否则读屏播报的位置与实际高亮的标签不一致。
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  // 切换项目时重置自动创建标记，允许新项目在面板打开时创建首个终端
  useEffect(() => {
    autoCreatedRef.current = false
  }, [])
  useEffect(() => {
    if (!open || restoring) {
      return
    }
    if (tabs.length === 0 && cwd && !autoCreatedRef.current) {
      autoCreatedRef.current = true
      void createTerminal({ cwd })
    }
  }, [open, restoring, tabs.length, cwd, createTerminal])

  // 活动标签打开时，自动选中第一个 pane
  useEffect(() => {
    if (
      open &&
      activeTab &&
      activeTab.panes.length > 0 &&
      !activeTab.panes.some((p) => p.id === activePaneId)
    ) {
      setActivePaneId(activeTab.panes[0]?.id ?? null)
    }
  }, [open, activeTab, activePaneId, setActivePaneId])

  // 活动 tab 内所有未连接的 pane 自动连接
  useEffect(() => {
    if (!activeTabId || !open) return
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return
    for (const pane of tab.panes) {
      if (!pane.ws && !pane.connecting) {
        connect(pane.id)
      }
    }
  }, [activeTabId, open, tabs, connect])

  // 拖拽调整面板高度
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault()
      draggingRef.current = true
      startYRef.current = e.clientY
      startHeightRef.current = height
      setDragging(true)
    },
    [height],
  )

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return
      const delta = startYRef.current - e.clientY
      setHeight(startHeightRef.current + delta)
    }
    const onUp = () => {
      draggingRef.current = false
      setDragging(false)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
  }, [dragging, setHeight])

  // 拖拽时设置全局光标
  useEffect(() => {
    if (!dragging) return
    const snapshot = lockBodyCursor('row-resize')
    return () => restoreBodyCursor(snapshot)
  }, [dragging])

  const handleNewTab = useCallback(() => {
    void createTerminal(cwd ? { cwd } : undefined)
  }, [createTerminal, cwd])

  const handleSplit = useCallback(
    (direction: SplitDirection) => {
      if (!activeTabId) return
      setSplitDirection(activeTabId, direction)
      void splitTerminal(cwd ? { cwd, direction } : { direction })
    },
    [activeTabId, splitTerminal, setSplitDirection, cwd],
  )

  const handleCloseTab = useCallback(
    (tabId: string, e: React.MouseEvent) => {
      e.stopPropagation()
      // 关闭标签内所有 pane
      const tabPanes = sessions.filter((s) => s.tabId === tabId)
      for (const pane of tabPanes) {
        void closeTerminal(pane.id)
      }
      // 关闭最后一个标签时同时收起面板
      if (tabs.length === 1 && open) {
        toggleOpen()
      }
    },
    [sessions, tabs.length, open, closeTerminal, toggleOpen],
  )

  const handleClosePane = useCallback(
    (paneId: string) => {
      void closeTerminal(paneId)
      // 关闭最后一个 pane（即最后一个标签的最后一个终端）时收起面板
      if (sessions.length === 1 && open) {
        toggleOpen()
      }
    },
    [closeTerminal, sessions.length, open, toggleOpen],
  )

  const handlePaneResize = useCallback(
    (id: string, cols: number, rows: number) => {
      void resize(id, cols, rows)
    },
    [resize],
  )

  // 分隔条拖拽
  const onDividerPointerDown = useCallback(
    (
      e: React.PointerEvent<HTMLElement>,
      tabId: string,
      leftIdx: number,
      direction: SplitDirection,
    ) => {
      e.preventDefault()
      e.stopPropagation()
      const container = e.currentTarget.parentElement
      if (!container) return
      const rect = container.getBoundingClientRect()
      const totalSize = direction === 'horizontal' ? rect.width : rect.height
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return

      const sizes = [...tab.split.sizes]
      const total = sizes.reduce((a, b) => a + b, 0) || 1
      const snapshot = lockBodyCursor(direction === 'horizontal' ? 'col-resize' : 'row-resize')

      const onMove = (ev: PointerEvent) => {
        const delta = direction === 'horizontal' ? ev.clientX - e.clientX : ev.clientY - e.clientY
        const deltaFraction = (delta / totalSize) * total

        const left = sizes[leftIdx]
        const right = sizes[leftIdx + 1]
        // 边界保护：索引越界时放弃本次调整
        if (left === undefined || right === undefined) return
        const newLeft = left + deltaFraction
        const newRight = right - deltaFraction

        // 最小 pane 约束
        const minFlex = minPaneFlex * total
        if (newLeft < minFlex || newRight < minFlex) return

        const newSizes = [...sizes]
        newSizes[leftIdx] = newLeft
        newSizes[leftIdx + 1] = newRight
        setPaneSizes(tabId, newSizes)
      }

      const onUp = () => {
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        // 恢复拖拽前的内联样式：此前读的是当前值（已是拖拽光标/user-select:none），
        // 清空后又写回同一份值——全站光标永久停在 col-resize、文本选择永久禁用。
        restoreBodyCursor(snapshot)
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    },
    [tabs, setPaneSizes, minPaneFlex],
  )

  // 分隔条键盘调整：ArrowLeft/Up 缩小左/上 pane，ArrowRight/Down 放大（±5% 总宽）
  const onDividerKeyDown = useCallback(
    (tabId: string, leftIdx: number, delta: number) => {
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return
      const sizes = [...tab.split.sizes]
      const total = sizes.reduce((a, b) => a + b, 0) || 1
      const left = sizes[leftIdx]
      const right = sizes[leftIdx + 1]
      if (left === undefined || right === undefined) return
      const deltaFraction = delta * total
      const newLeft = left + deltaFraction
      const newRight = right - deltaFraction
      const minFlex = minPaneFlex * total
      if (newLeft < minFlex || newRight < minFlex) return
      const newSizes = [...sizes]
      newSizes[leftIdx] = newLeft
      newSizes[leftIdx + 1] = newRight
      setPaneSizes(tabId, newSizes)
    },
    [tabs, setPaneSizes, minPaneFlex],
  )

  return (
    <>
      {/* 分隔条只在展开时存在：收起态下高度不可见，留着它等于给键盘用户一个
          可聚焦、方向键也能动、却看不到任何效果的死控件（terminal 面板本体
          display:none 后已移除可达性，这里同理）。 */}
      {open && (
        <hr
          className={resizeHandleStyle}
          onPointerDown={onPointerDown}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHeight(height + 20)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setHeight(Math.max(40, height - 20))
            }
          }}
          aria-orientation="horizontal"
          aria-label="调整终端面板高度"
          aria-valuemin={40}
          aria-valuemax={800}
          aria-valuenow={Math.round(height)}
          tabIndex={0}
        />
      )}
      {/* 收起时整块 display:none：不再以 height:0 布局隐藏内容——那样工具栏仍会
          排布在视口之外（y900+）且可被 Tab 聚焦却不可达；none 同时移除几何与焦点。
          xterm 实例保持挂载（与非活动标签相同的隐藏方式），重新展开时重算 fit。 */}
      <div className={panelStyle} style={open ? { height } : { display: 'none' }}>
        {/* 标签栏：role="toolbar" 而非 "tablist"。
            tablist 的必需子元素只有 tab（axe aria-required-children critical），
            而每个终端标签是「切换按钮 + 关闭按钮」两个平级控件——tab 角色装不下
            关闭钮（只能塞成后代 → nested-interactive），中间加壳又会违反
            aria-required-children。toolbar 允许任意按钮混排，正是「一组切换按钮」
            的正确语义；每个标签用 aria-pressed 表达「当前显示的是哪个」，
            方向键在同一 toolbar 内切换焦点，键盘可达性与读屏播报都正确。 */}
        <div className={headerStyle}>
          <div className={tabsStyle} role="toolbar" aria-label="终端标签">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                role="presentation"
                className={`${tabWrapStyle} ${tab.id === activeTabId ? tabActiveStyle : ''}`}
              >
                <button
                  ref={(el) => {
                    if (el) tabRefs.current.set(tab.id, el)
                    else tabRefs.current.delete(tab.id)
                  }}
                  className={tabStyle}
                  onClick={() => setActiveTabId(tab.id)}
                  onKeyDown={(e) => {
                    if (
                      e.key !== 'ArrowLeft' &&
                      e.key !== 'ArrowRight' &&
                      e.key !== 'Home' &&
                      e.key !== 'End'
                    )
                      return
                    e.preventDefault()
                    const idx = tabs.findIndex((t) => t.id === tab.id)
                    let nextIdx: number
                    if (e.key === 'Home') nextIdx = 0
                    else if (e.key === 'End') nextIdx = tabs.length - 1
                    else
                      nextIdx =
                        (idx + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
                    const next = tabs[nextIdx]
                    if (next) {
                      setActiveTabId(next.id)
                      // toolbar 内方向键应同时移动焦点，否则读屏播报的位置与
                      // 实际高亮的标签不一致。
                      //
                      // 必须延到下一帧：Terminal 的 visible 副作用在新标签变为可见
                      // 后才 focus xterm（切回来时好让用户直接输入），同步 focus 会被
                      // 它抢走——实测方向键切换后焦点恒落在 "Terminal input"，
                      // 再按方向键就打到终端里去而不是继续切标签。
                      const el = tabRefs.current.get(next.id)
                      requestAnimationFrame(() => el?.focus())
                    }
                  }}
                  aria-pressed={tab.id === activeTabId}
                  aria-label={`终端标签 ${shellLabel(tab.panes[0]?.shell ?? 'terminal')}`}
                  aria-controls={`term-panel-${tab.id}`}
                  type="button"
                >
                  <span>{shellLabel(tab.panes[0]?.shell ?? 'terminal')}</span>
                  {tab.panes.length > 1 && (
                    <span className={tabBadgeStyle}>{tab.panes.length}</span>
                  )}
                </button>
                {/* 关闭钮与切换按钮平级（不再是 role="tab" 的后代）：消除
                    nested-interactive；标签本身仍只占一个 Tab 停靠点。 */}
                <button
                  className={tabCloseStyle}
                  onClick={(e) => handleCloseTab(tab.id, e)}
                  aria-label={`关闭终端标签 ${shellLabel(tab.panes[0]?.shell ?? 'terminal')}`}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {/* 分屏按钮 */}
          <button
            className={iconBtnStyle}
            onClick={() => handleSplit('horizontal')}
            disabled={!activeTabId}
            aria-label="水平分屏"
            type="button"
            title="水平分屏（左右）"
          >
            ⫶
          </button>
          <button
            className={iconBtnStyle}
            onClick={() => handleSplit('vertical')}
            disabled={!activeTabId}
            aria-label="垂直分屏"
            type="button"
            title="垂直分屏（上下）"
          >
            ⬓
          </button>
          <button
            className={iconBtnStyle}
            onClick={handleNewTab}
            aria-label="新建终端"
            type="button"
            title="新建终端"
          >
            +
          </button>
          <button
            className={closePanelBtnStyle}
            onClick={toggleOpen}
            aria-label="收起终端面板"
            type="button"
            title="收起"
          >
            ▾
          </button>
        </div>
        {/* 终端渲染区 — 所有标签同时挂载，非活动标签用 display:none 隐藏。
            这样切换标签时 xterm 实例不会被销毁/重建，避免输入丢失和输出闪烁。
            每块带 id 与标签按钮的 aria-controls 对应；隐藏态 display:none 自动
            退出无障碍树，读屏不会遍历到不可见的终端。 */}
        <div className={termAreaStyle}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
              id={`term-panel-${tab.id}`}
              style={{
                display: tab.id === activeTabId ? 'flex' : 'none',
                width: '100%',
                height: '100%',
              }}
            >
              <PaneSplitContainer
                tab={tab}
                activePaneId={activePaneId}
                getWebSocket={getWebSocket}
                visible={open && tab.id === activeTabId}
                onPaneResize={handlePaneResize}
                onPaneClick={setActivePaneId}
                onPaneClose={handleClosePane}
                onDividerPointerDown={onDividerPointerDown}
                onDividerKeyDown={onDividerKeyDown}
                minPaneFlex={minPaneFlex}
              />
            </div>
          ))}
          {tabs.length === 0 && <div className={connectingStyle}>终端未连接</div>}
        </div>
      </div>
    </>
  )
}
