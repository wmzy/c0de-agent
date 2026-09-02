// src/web/components/PaneSplitContainer.tsx
// 分屏容器：根据方向渲染 pane 列表 + 可拖拽/键盘调整的分隔条。
// 从 TerminalPanel.tsx 拆出，独立管理 pane 布局样式与分隔条交互。

import { css } from '@linaria/core'
import { Fragment, useCallback } from 'react'
import { useFileReference } from '../contexts/ReferenceContext.js'
import type { SplitDirection, UseTerminalReturn } from '../hooks/useTerminal.js'
import { Terminal } from './Terminal.js'

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
  /* 覆盖全局 button 的 44px 触控最小尺寸，否则 22px pane 头被撑到 44px 浪费终端纵向空间 */
  min-height: auto;
  min-width: auto;

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
  border: none;
  padding: 0;
  margin: 0;

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
  border: none;
  padding: 0;
  margin: 0;

  &:hover {
    background: var(--primary);
  }
`

/** 从 shell 路径提取短名称用于标签显示。 */
function shellLabel(shell: string): string {
  return shell.split('/').pop() ?? shell
}

type PaneSplitContainerProps = {
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
  onDividerKeyDown: (tabId: string, leftIdx: number, delta: number) => void
  minPaneFlex: number
}

function PaneSplitContainer({
  tab,
  activePaneId,
  getWebSocket,
  visible,
  onPaneResize,
  onPaneClick,
  onPaneClose,
  onDividerPointerDown,
  onDividerKeyDown,
  minPaneFlex,
}: PaneSplitContainerProps) {
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
            onPointerDown={() => onPaneClick(pane.id)}
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
            <hr
              className={dividerClass}
              onPointerDown={(e) => onDividerPointerDown(e, tab.id, i, direction)}
              onKeyDown={(e) => {
                const horizontal = direction === 'horizontal'
                const delta = horizontal
                  ? e.key === 'ArrowLeft'
                    ? -0.05
                    : e.key === 'ArrowRight'
                      ? 0.05
                      : 0
                  : e.key === 'ArrowUp'
                    ? -0.05
                    : e.key === 'ArrowDown'
                      ? 0.05
                      : 0
                if (!delta) return
                e.preventDefault()
                onDividerKeyDown(tab.id, i, delta)
              }}
              aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
              aria-label="调整分屏大小"
              aria-valuemin={Math.round(minPaneFlex * 100)}
              aria-valuemax={100}
              aria-valuenow={Math.round(
                ((sizes[i] ?? 1) / (sizes.reduce((a, b) => a + b, 0) || 1)) * 100,
              )}
              tabIndex={0}
            />
          )}
        </Fragment>
      ))}
    </div>
  )
}

export type { PaneSplitContainerProps }
export { PaneSplitContainer }
