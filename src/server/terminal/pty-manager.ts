// src/server/terminal/pty-manager.ts

import { spawn, type IPty } from 'node-pty'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import type { WebSocket } from 'ws'

/** PTY 会话信息（返回给前端）。 */
export interface PTYInfo {
  id: string
  pid: number
  title: string
  cols: number
  rows: number
  cwd: string
  /** shell 程序路径。 */
  shell: string
  /** 所属项目 id（未归属时为 undefined）。 */
  projectId?: string
}

/** 内部 PTY 条目：进程 + 元信息 + 活跃 WebSocket 连接集合 + 输出缓冲。 */
interface PTYEntry {
  pty: IPty
  info: PTYInfo
  sockets: Set<WebSocket>
  /** 近期 PTY 输出环形缓冲，WS 重连时回放以恢复终端画面。 */
  scrollback: string
}

export interface CreatePTYOptions {
  cwd: string
  cols?: number
  rows?: number
  title?: string
  /** 覆盖默认 shell；不传则自动检测。 */
  shell?: string
  /** 所属项目 id。 */
  projectId?: string
}

/**
 * 检测当前平台默认 shell。
 *
 * 优先级：process.env.SHELL → os.userInfo().shell（/etc/passwd 登录 shell）→ /bin/bash。
 * 仅依赖 process.env.SHELL 是不可靠的：当 server 经 npm 脚本（sh -c 包装）、
 * 热更新重启或 IDE 启动器等链路启动时，SHELL 往往未被 export 到环境，
 * 导致 node 进程读不到而错误回退到 /bin/bash。userInfo().shell 直接读取
 * /etc/passwd（getpwuid），是用户真实登录 shell 的可靠来源。
 */
export function detectShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC ?? 'cmd.exe'
  }
  return process.env.SHELL ?? userInfo().shell ?? '/bin/bash'
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const MAX_TITLE_LEN = 100
/** scrollback 环形缓冲最大字节数（约 50KB）。 */
const SCROLLBACK_MAX = 50_000

function truncateTitle(title: string): string {
  const clean = title.replace(/[\r\n]/g, ' ').trim()
  return clean.length > MAX_TITLE_LEN ? `${clean.slice(0, MAX_TITLE_LEN)}…` : clean
}

/**
 * PTY 生命周期管理器。
 *
 * 负责 spawn / write / resize / kill 伪终端进程，并将 PTY 输出
 * 通过 WebSocket 推送到前端。一个 PTY 可同时挂多个 WebSocket
 * （多标签共享同一终端），任一 WS 断开不影响进程。
 */
export class PTYManager {
  private entries = new Map<string, PTYEntry>()

  /** 创建新 PTY 会话。 */
  create(opts: CreatePTYOptions): PTYInfo {
    const id = `pty_${randomUUID()}`
    const cols = opts.cols ?? DEFAULT_COLS
    const rows = opts.rows ?? DEFAULT_ROWS
    const shell = opts.shell ?? detectShell()

    const pty = spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    })

    const info: PTYInfo = {
      id,
      pid: pty.pid,
      title: truncateTitle(opts.title ?? shell),
      cols,
      rows,
      cwd: opts.cwd,
      shell,
      projectId: opts.projectId,
    }

    const entry: PTYEntry = { pty, info, sockets: new Set(), scrollback: '' }

    // PTY 输出 → 广播到所有挂载的 WebSocket + 追加 scrollback
    pty.onData((data) => {
      entry.scrollback += data
      if (entry.scrollback.length > SCROLLBACK_MAX) {
        entry.scrollback = entry.scrollback.slice(-SCROLLBACK_MAX)
      }
      for (const ws of entry.sockets) {
        if (ws.readyState === ws.OPEN) {
          ws.send(data)
        }
      }
    })

    // PTY 退出 → 通知所有 WS 并清理
    pty.onExit(({ exitCode }) => {
      for (const ws of entry.sockets) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'exit', exitCode }))
          ws.close(1000, 'pty exited')
        }
      }
      this.entries.delete(id)
    })

    this.entries.set(id, entry)
    return info
  }

  /** 向 PTY stdin 写入数据。 */
  write(id: string, data: string): void {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`PTY not found: ${id}`)
    entry.pty.write(data)
  }

  /** 调整 PTY 尺寸。 */
  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`PTY not found: ${id}`)
    entry.pty.resize(Math.max(1, cols), Math.max(1, rows))
    entry.info.cols = cols
    entry.info.rows = rows
  }

  /** 更新 PTY 标题。 */
  setTitle(id: string, title: string): void {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`PTY not found: ${id}`)
    entry.info.title = truncateTitle(title)
  }

  /** 终止 PTY 进程。 */
  kill(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    // 通知所有 WS
    for (const ws of entry.sockets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', exitCode: 0 }))
        ws.close(1000, 'pty killed')
      }
    }
    try {
      entry.pty.kill()
    } catch {
      // 进程可能已退出
    }
    this.entries.delete(id)
  }

  /** 获取 PTY 信息。 */
  get(id: string): PTYInfo | undefined {
    return this.entries.get(id)?.info
  }

  /** 列出所有活跃 PTY。 */
  list(): PTYInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }))
  }

  /**
   * 将 WebSocket 挂载到 PTY，建立双向数据流：
   * - PTY onData → WS send（终端输出）
   * - WS onMessage → PTY write（用户输入）
   * - WS onClose → 摘除连接（PTY 保持存活）
   */
  attachWebSocket(id: string, ws: WebSocket): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false

    entry.sockets.add(ws)

    // 先回放 scrollback，让前端恢复终端历史画面。
    // 先 add 再 send 避免漏数据：add 之后 onData 的新输出会广播到此 WS，
    // 而 scrollback 覆盖 add 之前的所有历史输出。Node 单线程保证无竞态。
    if (entry.scrollback) {
      ws.send(entry.scrollback)
    }

    ws.on('message', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString('utf8')
      try {
        entry.pty.write(text)
      } catch {
        // PTY 可能已退出
      }
    })

    ws.on('close', () => {
      entry.sockets.delete(ws)
    })

    ws.on('error', () => {
      entry.sockets.delete(ws)
    })

    return true
  }

  /** 终止所有 PTY 进程（服务器关闭时调用）。 */
  dispose(): void {
    for (const id of this.entries.keys()) {
      this.kill(id)
    }
  }
}
