// src/web/components/TerminalPanel.tsx

import { css } from '@linaria/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from './Terminal.js'
import type { UseTerminalReturn } from '../hooks/useTerminal.js'

interface TerminalPanelProps {
  terminal: UseTerminalReturn
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

const newBtnStyle = css`
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
    background: var(--bg);
    color: var(--text);
  }
`

const closeBtnStyle = css`
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
 * 终端面板：底部可拖拽调整高度的容器，支持多标签页。
 *
 * - 标签栏：切换 / 新建(+)/ 关闭(×)
 * - 高度拖拽：上拉/下拉调整，记忆到 localStorage
 * - 隐藏时高度为 0（仅显示拖拽条）
 */
export function TerminalPanel({ terminal }: TerminalPanelProps) {
  const { sessions, activeId, height, open, setActiveId, createTerminal, connect, closeTerminal, resize, getWebSocket, setHeight, toggleOpen } = terminal
  const draggingRef = useRef(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const activeSession = sessions.find((s) => s.id === activeId) ?? null

  // 面板打开且有终端但无活动终端时，自动选中第一个
  useEffect(() => {
    if (open && sessions.length > 0 && !activeId) {
      const first = sessions[0]
      if (first) setActiveId(first.id)
    }
  }, [open, sessions, activeId, setActiveId])

  // 面板打开时自动创建首个终端
  useEffect(() => {
    if (open && sessions.length === 0) {
      void createTerminal()
    }
  }, [open, sessions.length, createTerminal])

  // 活动 ID 对应的终端未连接时自动连接
  useEffect(() => {
    if (!activeId || !open) return
    const session = sessions.find((s) => s.id === activeId)
    if (session && !session.ws && !session.connecting) {
      connect(activeId)
    }
  }, [activeId, open, sessions, connect])

  // 拖拽调整高度
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
    void createTerminal()
  }, [createTerminal])

  const handleCloseTab = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      void closeTerminal(id)
    },
    [closeTerminal],
  )

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (!activeId) return
      void resize(activeId, cols, rows)
    },
    [activeId, resize],
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
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`${tabStyle} ${s.id === activeId ? tabActiveStyle : ''}`}
                onClick={() => setActiveId(s.id)}
                role="tab"
                aria-selected={s.id === activeId}
              >
                <span>{s.title || shellLabel(s.shell)}</span>
                <button
                  className={tabCloseStyle}
                  onClick={(e) => handleCloseTab(s.id, e)}
                  aria-label="关闭终端"
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button className={newBtnStyle} onClick={handleNewTab} aria-label="新建终端" type="button" title="新建终端">
            +
          </button>
            <button
            className={closeBtnStyle}
            onClick={toggleOpen}
            aria-label="收起终端面板"
            type="button"
            title="收起"
          >
            ▾
          </button>
        </div>
        {/* 终端渲染区 */}
        <div className={termAreaStyle}>
          {activeSession ? (
            <Terminal
              ws={getWebSocket(activeSession.id)}
              visible={open}
              onResize={handleResize}
            />
          ) : (
            <div className={connectingStyle}>终端未连接</div>
          )}
        </div>
      </div>
    </>
  )
}
