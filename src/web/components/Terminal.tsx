// src/web/components/Terminal.tsx

import { useCallback, useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface TerminalProps {
  /** WebSocket 连接（由 useTerminal hook 管理）。 */
  ws: WebSocket | null
  /** 终端可见时为 true（隐藏时暂停 fit 计算）。 */
  visible: boolean
  /** 终端尺寸变化时通知后端（cols, rows）。 */
  onResize?: (cols: number, rows: number) => void
}

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
export function Terminal({ ws, visible, onResize }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

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
    const onMessage = (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : event.data.toString('utf8')
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

    // xterm 输入 → WS
    const onTermData = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    }

    ws.addEventListener('message', onMessage)
    const disposable = term.onData(onTermData)

    // WS（重）连接后强制 shell 重绘 prompt。
    // - 首次连接：shell 自然输出 prompt，Ctrl+L 无副作用。
    // - 页面刷新后重连：PTY 存活但无待发输出，xterm 一片空白。
    //   发送 Ctrl+L（\x0c）让 shell 清屏重绘，恢复可见 prompt。
    // 同时触发 resize 同步 PTY 尺寸。
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('\x0c')
    }
    requestAnimationFrame(() => doFit())

    return () => {
      ws.removeEventListener('message', onMessage)
      disposable.dispose()
    }
  }, [ws, doFit])

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

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        padding: '4px 8px',
        overflow: 'hidden',
      }}
    />
  )
}

