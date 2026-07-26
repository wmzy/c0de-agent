// src/web/components/TerminalPanel.tsx

import { css } from '@linaria/core'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useFileReference } from '../contexts/ReferenceContext.js'
import type { SplitDirection, UseTerminalReturn } from '../hooks/useTerminal.js'
import { Terminal } from './Terminal.js'

interface TerminalPanelProps {
  terminal: UseTerminalReturn
  /** 新终端的默认工作目录（通常为项目 worktree）。未提供时使用服务端默认。 */
  cwd?: string
  /** 当前项目 id（用于切换项目时重置自动创建标记）。 */
  projectId: string
}

const panelStyle = css`
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  background: #0d1117;
  border-top: 1px solid var(--border);
  overflow: hidden;
`

const headerStyle = css`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  height: 36px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
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
    background: var(--border);
    border-radius: 2px;
  }
`

const tabStyle = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s, color 0.1s;

  &:hover {
    background: var(--bg);
    color: var(--text);
  }
`

const tabActiveStyle = css`
  background: var(--bg);
  color: var(--text);
  border-color: var(--border);
`

const tabBadgeStyle = css`
  font-size: 10px;
  background: var(--border);
  color: var(--text);
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
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  border-radius: 3px;
  padding: 0;
  line-height: 1;

  &:hover {
    background: var(--error);
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
  color: var(--text-secondary);
  font-size: 15px;
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;

  &:hover {
    background: var(--bg);
    color: var(--text);
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
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;

  &:hover {
    background: var(--error);
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

const splitContainerHStyle = css`
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  overflow: hidden;
`

const splitContainerVStyle = css`
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
`

const paneStyle = css`
  position: relative;
  overflow: hidden;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
`

const paneActiveStyle = css`
  // 用极细边框标识活动 pane
  outline: 1px solid var(--primary);
  outline-offset: -1px;
`

const paneHeaderStyle = css`
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 11px;
  color: var(--text-secondary);
  user-select: none;
  flex-shrink: 0;
`

const paneCloseStyle = css`
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
  padding: 0;
  line-height: 1;

  &:hover {
    background: var(--error);
    color: #fff;
  }
`

const dividerHStyle = css`
  width: 4px;
  cursor: col-resize;
  background: var(--border);
  flex-shrink: 0;
  transition: background 0.12s;
  z-index: 1;

  &:hover {
    background: var(--primary);
  }
`

const dividerVStyle = css`
  height: 4px;
  cursor: row-resize;
  background: var(--border);
  flex-shrink: 0;
  transition: background 0.12s;
  z-index: 1;

  &:hover {
    background: var(--primary);
  }
`

const resizeHandleStyle = css`
  height: 4px;
  cursor: row-resize;
  background: var(--border);
  flex-shrink: 0;
  transition: background 0.12s;

  &:hover {
    background: var(--primary);
  }
`

const connectingStyle = css`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
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
 * - 隐藏时高度为 0（仅显示拖拽条）
 */
export function TerminalPanel({ terminal, cwd, projectId }: TerminalPanelProps) {
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
      setActivePaneId(activeTab.panes[0]?.id)
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
    const { cursor, userSelect } = document.body.style
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = cursor
      document.body.style.userSelect = userSelect
    }
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
        const { cursor, userSelect } = document.body.style
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        // 恢复原来的（无操作，因为上面已经清了）
        document.body.style.cursor = cursor
        document.body.style.userSelect = userSelect
      }

      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [tabs, setPaneSizes, minPaneFlex],
  )

  return (
    <>
      <div
        className={resizeHandleStyle}
        onPointerDown={onPointerDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整终端面板高度"
      />
      <div className={panelStyle} style={{ height: open ? height : 0 }}>
        {/* 标签栏 */}
        <div className={headerStyle}>
          <div className={tabsStyle}>
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`${tabStyle} ${tab.id === activeTabId ? tabActiveStyle : ''}`}
                onClick={() => setActiveTabId(tab.id)}
                role="tab"
                aria-selected={tab.id === activeTabId}
              >
                <span>{shellLabel(tab.panes[0]?.shell ?? 'terminal')}</span>
                {tab.panes.length > 1 && <span className={tabBadgeStyle}>{tab.panes.length}</span>}
                <button
                  className={tabCloseStyle}
                  onClick={(e) => handleCloseTab(tab.id, e)}
                  aria-label="关闭终端标签"
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
            这样切换标签时 xterm 实例不会被销毁/重建，避免输入丢失和输出闪烁。 */}
        <div className={termAreaStyle}>
          {tabs.map((tab) => (
            <div
              key={tab.id}
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
              />
            </div>
          ))}
          {tabs.length === 0 && <div className={connectingStyle}>终端未连接</div>}
        </div>
      </div>
    </>
  )
}

/** 分屏容器：根据方向渲染 pane 列表 + 分隔条。 */
function PaneSplitContainer({
  tab,
  activePaneId,
  getWebSocket,
  visible,
  onPaneResize,
  onPaneClick,
  onPaneClose,
  onDividerPointerDown,
}: {
  tab: NonNullable<UseTerminalReturn['tabs'][number]>
  activePaneId: string | null
  getWebSocket: (id: string) => WebSocket | null
  visible: boolean
  onPaneResize: (id: string, cols: number, rows: number) => void
  onPaneClick: (id: string) => void
  onPaneClose: (id: string) => void
  onDividerPointerDown: (
    e: React.PointerEvent<HTMLElement>,
    tabId: string,
    leftIdx: number,
    direction: SplitDirection,
  ) => void
}) {
  const { direction, sizes } = tab.split
  const containerClass = direction === 'horizontal' ? splitContainerHStyle : splitContainerVStyle
  const dividerClass = direction === 'horizontal' ? dividerHStyle : dividerVStyle

  const fileRef = useFileReference()
  const handleAddToChat = useCallback(
    (label: string, content: string) => {
      fileRef?.insertTerminalReference(label, content)
    },
    [fileRef],
  )

  return (
    <div className={containerClass} style={{ flex: 1 }}>
      {tab.panes.map((pane, i) => (
        <Fragment key={pane.id}>
          {/* pane */}
          <div
            className={`${paneStyle} ${pane.id === activePaneId ? paneActiveStyle : ''}`}
            style={{
              flexGrow: sizes[i] ?? 1,
              flexBasis: 0,
            }}
            onMouseDown={() => onPaneClick(pane.id)}
          >
            <div className={paneHeaderStyle}>
              <span>{shellLabel(pane.shell)}</span>
              <button
                className={paneCloseStyle}
                onClick={(e) => {
                  e.stopPropagation()
                  onPaneClose(pane.id)
                }}
                aria-label="关闭分屏"
                type="button"
              >
                ×
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <Terminal
                ws={getWebSocket(pane.id)}
                visible={visible}
                onResize={(cols, rows) => onPaneResize(pane.id, cols, rows)}
                onAddToChat={handleAddToChat}
              />
            </div>
          </div>
          {/* 分隔条（最后一个 pane 后不加） */}
          {i < tab.panes.length - 1 && (
            <div
              className={dividerClass}
              onPointerDown={(e) => onDividerPointerDown(e, tab.id, i, direction)}
              role="separator"
              aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
            />
          )}
        </Fragment>
      ))}
    </div>
  )
}
