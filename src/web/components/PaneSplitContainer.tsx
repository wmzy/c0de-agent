// src/web/components/PaneSplitContainer.tsx
// 分屏容器：根据方向渲染 pane 列表 + 可拖拽/键盘调整的分隔条。
// 从 TerminalPanel.tsx 拆出，独立管理 pane 布局样式与分隔条交互。

import { css } from '@linaria/core'
import { Fragment, useCallback } from 'react'
import { Terminal } from '@/components/Terminal.js'
import type { TerminalControlMessage } from '@/components/terminal-control.js'
import { useFileReference } from '@/contexts/ReferenceContext.js'
import type { SplitDirection, TerminalSession, UseTerminalReturn } from '@/hooks/useTerminal.js'

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
  outline: 1px solid var(--haze-color-primary);
  outline-offset: -1px;
`

/**
 * 分屏 pane 头部样式。
 *
 * 背景与文字都**不跟主题走**：pane 头贴在终端本体的固定深色面（#0d1117，
 * TerminalPanel/Terminal 的 xterm 主题亦为写死的深色）上——浅色主题下这里仍
 * 是深色背景，而 --haze-color-text-secondary 在浅色主题解析为 oklch(0.409 0 0)
 * 的深灰，落在深色面上只有 2.03:1（axe color-contrast serious）。
 *
 * 实测两主题（390/1440 复测一致）：
 * - 浅色：oklch(0.409) 深灰 × #0d1117+3% 白 = 2.03:1（需 4.5:1）
 * - 深色：oklch(0.757) × 深色面 = 9.3:1（达标，但两主题色值不同会让
 *   同一个「zsh」标签在切主题时跳色——既不一致也不可预期）
 *
 * 统一取终端前景色系（与 xterm 默认前景 #c9d1d9 同一色族）：静态色值在两主题
 * 下都是 9:1 以上，且切主题不跳色。关闭按钮同样在深色面上，按钮禁用态
 * 透明度 0.35 后仍需 ≥4.5:1，故不给按钮单独降透明度。
 */
const paneHeaderStyle = css`
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 6px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 11px;
  /* 固定浅色：pane 头永远贴在终端的深色面上（见上方说明），不随主题切换 */
  color: #c9d1d9;
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
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
  padding: 0;
  line-height: 1;
  /* 覆盖全局 button 的 44px 触控最小尺寸，否则 22px pane 头被撑到 44px 浪费终端纵向空间 */
  min-height: auto;
  min-width: auto;

  /* 同 paneStatusActionStyle：hover 得与 global.ts 的
     :where(button):hover:not(:disabled):not([aria-disabled='true']) 同形状（0,3,0），
     否则被全局中性底色压掉，只剩固定浅色 #c9d1d9 落在浅灰底上（实测 1.36:1）——
     鼠标移到这颗杀掉分屏 PTY 的 × 上时字形消失。 */
  &:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--haze-color-danger);
    color: var(--c0de-danger-on-solid, #fff);
  }

  &:focus-visible {
    outline: 2px solid #c9d1d9;
    outline-offset: -2px;
  }
`

/**
 * pane 底部状态条：连接中 / PTY 已退出 / 挂载被拒。
 * 贴终端的固定深色面（同 paneHeader 的取舍），用琥珀色与 xterm 的退出提示同色族。
 */
const paneStatusStyle = css`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 3px 8px;
  background: rgba(255, 255, 255, 0.03);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 11px;
  color: #c9d1d9;
  user-select: none;
`

const paneStatusActionStyle = css`
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 8px;
  border: 1px solid rgba(201, 209, 217, 0.45);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 11px;
  cursor: pointer;
  /* 覆盖全局 button 的 44px 触控最小尺寸，pane 状态条不撑高终端区 */
  min-height: auto;
  min-width: auto;

  /* hover 必须与 global.ts 的
     :where(button):hover:not(:disabled):not([aria-disabled='true']) 同形状：
     :where() 只包住 button 本体，:hover 与两个 :not() 在其外，特异度 (0,3,0)
     高于单类 (0,1,0)——写成 &:hover 会被全局中性底色压掉，在这个贴深色终端面的
     按钮上表现为「悬停即变成浅灰底 + 浅色字」，文字几乎消失（实测 axe 级对比度
     失效）。同形状后按源序，本组件晚于 global.ts 求值，hover 底色才成立。 */
  &:hover:not(:disabled):not([aria-disabled='true']) {
    background: rgba(201, 209, 217, 0.15);
  }

  &:focus-visible {
    outline: 2px solid #c9d1d9;
    outline-offset: -2px;
  }
`

const dividerHStyle = css`
  width: 4px;
  cursor: col-resize;
  background: var(--haze-color-border);
  flex-shrink: 0;
  transition: background 0.12s;
  z-index: 1;
  border: none;
  padding: 0;
  margin: 0;

  &:hover {
    background: var(--haze-color-primary);
  }
`

const dividerVStyle = css`
  height: 4px;
  cursor: row-resize;
  background: var(--haze-color-border);
  flex-shrink: 0;
  transition: background 0.12s;
  z-index: 1;
  border: none;
  padding: 0;
  margin: 0;

  &:hover {
    background: var(--haze-color-primary);
  }
`

/** 从 shell 路径提取短名称用于标签显示。 */
function shellLabel(shell: string): string {
  return shell.split('/').pop() ?? shell
}

/**
 * pane 状态条文案（null = 不显示）。
 *
 * 终态必须说出口：PTY 已退出 / 挂载被拒之后，pane 里只剩一屏静止的历史输出，
 * 光标停在原地，界面没有任何迹象说明它已经不能输入了——看上去就是一个还在的
 * 终端。连通中也要报，否则连不上与正在起是两副面孔。
 */
function paneStatus(pane: TerminalSession): string | null {
  if (pane.dead === 'exited') {
    return pane.exitCode === undefined
      ? '进程已退出，此终端已不可输入'
      : `进程已退出（退出码 ${pane.exitCode}），此终端已不可输入`
  }
  if (pane.dead === 'unreachable') {
    return '该进程已不存在（可能随服务重启结束），重连失败'
  }
  if (pane.connecting && !pane.ws) return '正在连接…'
  return null
}

type PaneSplitContainerProps = {
  tab: NonNullable<UseTerminalReturn['tabs'][number]>
  activePaneId: string | null
  getWebSocket: (id: string) => WebSocket | null
  visible: boolean
  onPaneResize: (id: string, cols: number, rows: number) => void
  onPaneClick: (id: string) => void
  onPaneClose: (id: string) => void
  /** 新开一个终端（pane 状态条的出口按钮）。 */
  onNewTerminal: () => void
  /** 终端控制帧（PTY 退出 / 挂载被拒）上报给连接生命周期。 */
  onPaneControl: (paneId: string, control: TerminalControlMessage) => void
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
  onNewTerminal,
  onPaneControl,
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
      {tab.panes.map((pane, i) => {
        const status = paneStatus(pane)
        return (
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
                  onControl={(control) => onPaneControl(pane.id, control)}
                />
              </div>
              {status && (
                <div className={paneStatusStyle} data-testid="terminal-pane-status">
                  <span>{status}</span>
                  <button
                    className={paneStatusActionStyle}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onNewTerminal()
                    }}
                  >
                    新建终端
                  </button>
                </div>
              )}
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
        )
      })}
    </div>
  )
}

export type { PaneSplitContainerProps }
export { PaneSplitContainer }
