// src/web/components/Terminal.tsx

import { css } from '@linaria/core'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as XTerm } from '@xterm/xterm'
import { useCallback, useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'

interface TerminalProps {
  /** WebSocket 连接（由 useTerminal hook 管理）。 */
  ws: WebSocket | null
  /** 终端可见时为 true（隐藏时暂停 fit 计算）。 */
  visible: boolean
  /** 终端尺寸变化时通知后端（cols, rows）。 */
  onResize?: (cols: number, rows: number) => void
  /** 终端 Add to Chat 回调（选区或命令块引用）。 */
  onAddToChat?: (label: string, content: string) => void
}

/** 命令块：一个用户命令及其输出的行范围。 */
interface CommandBlock {
  /** 终端绝对行号（baseY + cursorY），稳定标识。 */
  startRow: number
  /** 命令文本（用户输入）。 */
  command: string
}

const addToChatBtnStyle = css`
  position: absolute;
  top: 4px;
  left: 8px;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--text);
  background: var(--bg-secondary, #1c2128);
  border: 1px solid var(--primary, #4a9eff);
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: background 0.12s;

  &:hover {
    background: var(--primary, #4a9eff);
    color: #fff;
  }
`

const blockHighlightStyle = css`
  position: absolute;
  left: 0;
  right: 0;
  z-index: 5;
  background: rgba(74, 158, 255, 0.08);
  border-left: 2px solid var(--primary, #4a9eff);
  pointer-events: none;
`

/**
 * xterm.js 终端渲染组件。
 *
 * 职责：
 * - 创建 xterm.js 实例并挂载到容器 DOM
 * - WS onmessage → xterm.write（终端输出）
 * - xterm.onData → WS.send（用户输入）
 * - 容器 resize → FitAddon.proposeDimensions → 通知后端 resize
 *
 * WS 生命周期由父组件（useTerminal）管理；本组件只负责数据桥接和渲染。
 * ws 为 null 时显示「正在连接…」占位。
 */
export function Terminal({ ws, visible, onResize, onAddToChat }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  // 命令块追踪状态
  const blocksRef = useRef<CommandBlock[]>([])
  const currentInputRef = useRef('')
  const wasAlternateRef = useRef(false)
  // 选区 + 块悬停状态
  const [selection, setSelection] = useState<string | null>(null)
  const [hoverBlock, setHoverBlock] = useState<{
    top: number
    height: number
    block: CommandBlock
  } | null>(null)

  /** 执行 fit 并通知后端尺寸变化。 */
  const doFit = useCallback(() => {
    const fit = fitRef.current
    const term = termRef.current
    if (!fit || !term) return
    try {
      fit.fit()
      onResizeRef.current?.(term.cols, term.rows)
    } catch {
      // 容器可能还未布局
    }
  }, [])

  // 初始化 xterm.js 实例（只创建一次）
  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Source Code Pro', monospace",
      allowProposedApi: true,
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#e6edf3',
        cursorAccent: '#0d1117',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)

    termRef.current = term
    fitRef.current = fit

    // 选区变化追踪
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      setSelection(sel && sel.length > 0 ? sel : null)
    })

    // 延迟一帧让 DOM 布局完成后再 fit
    requestAnimationFrame(() => doFit())

    return () => {
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // 桥接 WebSocket ↔ xterm
  useEffect(() => {
    const term = termRef.current
    if (!term) return

    if (!ws) return

    // WS 数据 → xterm
    const processData = (data: string) => {
      // 检查是否为 JSON 控制消息（exit/error）
      if (data.startsWith('{') && data.includes('"type"')) {
        try {
          const msg = JSON.parse(data)
          if (msg.type === 'exit') {
            term.write(`\r\n\x1b[33m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`)
            return
          }
          if (msg.type === 'error') {
            term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`)
            return
          }
        } catch {
          // 非 JSON，当作普通数据写入
        }
      }
      term.write(data)
    }

    const onMessage = (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : event.data.toString('utf8')
      processData(data)
    }

    // xterm 输入 → WS + 命令块追踪
    const onTermData = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
      // 命令块追踪：跳过 alternate buffer（vim/less/top 等全屏程序）
      const isAlt = term.buffer.active.type === 'alternate'
      if (isAlt) {
        wasAlternateRef.current = true
        currentInputRef.current = ''
        return
      }
      // 从 alternate 切回 normal 时清空输入缓存
      if (wasAlternateRef.current) {
        wasAlternateRef.current = false
        currentInputRef.current = ''
      }
      for (const char of data) {
        if (char === '\r') {
          const absRow = term.buffer.active.baseY + term.buffer.active.cursorY
          blocksRef.current.push({
            startRow: absRow,
            command: currentInputRef.current,
          })
          // 修剪被 scrollback 裁掉的旧块
          const maxRow = term.buffer.active.length
          blocksRef.current = blocksRef.current.filter((b) => b.startRow <= maxRow)
          currentInputRef.current = ''
        } else if (char >= ' ') {
          // 可打印字符累积到当前输入（跳过控制字符）
          currentInputRef.current += char
        }
      }
    }

    // 先清空早期缓冲（scrollback），再切换到正式 onmessage 处理器。
    // connect() 设置的 ws.onmessage 缓冲在此 effect 运行时被消费。
    const earlyData = (ws as WebSocket & { __earlyData?: string[] }).__earlyData
    if (earlyData) {
      for (const data of earlyData) {
        processData(data)
      }
      earlyData.length = 0
    }
    ws.onmessage = null

    ws.addEventListener('message', onMessage)
    const disposable = term.onData(onTermData)

    // scrollback 由后端在 WS attach 时自动回放，前端无需发送 Ctrl+L。
    // 仅触发 resize 同步 PTY 尺寸。
    requestAnimationFrame(() => doFit())

    return () => {
      ws.removeEventListener('message', onMessage)
      disposable.dispose()
    }
  }, [ws, doFit])

  // 终端（重）连接或变为可见时自动获取焦点。
  // 切换项目回来后 WS 重连，新 xterm 实例默认无焦点 → 用户无法输入。
  useEffect(() => {
    if (!visible || !ws || !termRef.current) return
    termRef.current.focus()
  }, [visible, ws])

  // 可见性变化时重新 fit
  useEffect(() => {
    if (!visible) return
    // 延迟一帧让布局完成
    const timer = requestAnimationFrame(() => doFit())
    return () => cancelAnimationFrame(timer)
  }, [visible, doFit])

  // 监听容器 resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => doFit())
    observer.observe(container)
    return () => observer.disconnect()
  }, [doFit])

  /** 鼠标悬停时计算命令块高亮。 */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // 有选区时不显示块高亮
      if (selection) {
        if (hoverBlock) setHoverBlock(null)
        return
      }
      const term = termRef.current
      const container = containerRef.current
      if (!term || !container) return
      // 仅 normal buffer 追踪块
      if (term.buffer.active.type === 'alternate') {
        if (hoverBlock) setHoverBlock(null)
        return
      }
      const rect = container.getBoundingClientRect()
      const cellHeight = rect.height / term.rows
      const row = Math.floor((e.clientY - rect.top) / cellHeight)
      const absRow = term.buffer.active.baseY + row

      // 查找 absRow 所在的块
      const blocks = blocksRef.current
      let foundIdx = -1
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]
        if (!block) continue
        const endRow = blocks[i + 1]?.startRow ?? Infinity
        if (absRow >= block.startRow && absRow < endRow) {
          foundIdx = i
          break
        }
      }
      if (foundIdx === -1) {
        if (hoverBlock) setHoverBlock(null)
        return
      }
      // 计算块在视口内的像素范围
      const block = blocks[foundIdx]
      if (!block) {
        if (hoverBlock) setHoverBlock(null)
        return
      }
      const nextStart = blocks[foundIdx + 1]?.startRow ?? term.buffer.active.baseY + term.rows
      const startViewportRow = block.startRow - term.buffer.active.baseY
      const endViewportRow = nextStart - term.buffer.active.baseY
      const top = Math.max(0, startViewportRow) * cellHeight
      const bottom = Math.min(term.rows, endViewportRow) * cellHeight
      const height = bottom - top
      if (height <= 0) {
        if (hoverBlock) setHoverBlock(null)
        return
      }
      setHoverBlock({ top, height, block })
    },
    [selection, hoverBlock],
  )

  /** 鼠标离开时清除块高亮。 */
  const handleMouseLeave = useCallback(() => {
    if (hoverBlock) setHoverBlock(null)
  }, [hoverBlock])

  /** 从终端 buffer 提取命令块文本。 */
  const extractBlockText = useCallback((block: CommandBlock): string => {
    const term = termRef.current
    if (!term) return block.command
    const blocks = blocksRef.current
    const idx = blocks.indexOf(block)
    const endRow =
      blocks[idx + 1]?.startRow ?? term.buffer.active.baseY + term.buffer.active.cursorY
    const lines: string[] = []
    for (let i = block.startRow; i <= endRow && i < term.buffer.active.length; i++) {
      const line = term.buffer.active.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    return lines.join('\n').replace(/\n+$/, '')
  }, [])

  /** Add to Chat 按钮点击。 */
  const handleAddToChat = useCallback(() => {
    if (selection) {
      onAddToChat?.('🖥 终端选区', selection)
      // 引用后清除选区
      termRef.current?.clearSelection()
      setSelection(null)
    } else if (hoverBlock) {
      const content = extractBlockText(hoverBlock.block)
      const cmd = hoverBlock.block.command.trim()
      const label = cmd ? `🖥 命令: ${cmd.length > 30 ? `${cmd.slice(0, 30)}…` : cmd}` : '🖥 终端输出'
      onAddToChat?.(label, content)
    }
  }, [selection, hoverBlock, extractBlockText, onAddToChat])

  const showAddToChat = onAddToChat && (selection || hoverBlock)

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 终端容器需捕获鼠标事件用于命令块高亮
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        padding: '4px 8px',
        overflow: 'hidden',
        position: 'relative',
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {showAddToChat && (
        <button
          className={addToChatBtnStyle}
          onClick={handleAddToChat}
          type="button"
          aria-label="添加到会话"
        >
          ＋ Add to Chat
        </button>
      )}
      {!selection && hoverBlock && (
        <div
          className={blockHighlightStyle}
          style={{ top: hoverBlock.top, height: hoverBlock.height }}
        />
      )}
    </div>
  )
}
