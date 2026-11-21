// LSP 客户端：spawn 服务器进程 + Content-Length 帧编解码 + JSON-RPC id 路由
// + 文档全文同步（textDocumentSync=1）+ 诊断缓存与新鲜度判定。
// pending 管理复用 shared/jsonrpc-pending；帧思路同 dap/protocol.ts，但 LSP
// 是 header 帧且通知/服务器→客户端请求语义不同，此处独立实现。

import { spawn as childSpawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { getLogger } from '../core/logger.js'
import { createPendingRequests } from '../shared/jsonrpc-pending.js'
import { errorMessage } from '../shared/utils/string.js'
import {
  extensionOf,
  type LspDiagnostic,
  type LspLocation,
  type LspLocationLink,
  type LspServerDef,
  languageIdForExtension,
  pathToFileUri,
} from './types.js'

const logger = getLogger('lsp.client')

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const INITIALIZE_TIMEOUT_MS = 20_000
const SHUTDOWN_TIMEOUT_MS = 3_000
const EXIT_GRACE_MS = 1_000
/** 诊断新鲜度：version 未回显的服务器（typescript-language-server）采信前
 *  的静默窗口——窗口内无新 publish 且至少收到过一个新 publish。 */
const DIAGNOSTICS_SETTLE_MS = 300
const DIAGNOSTICS_POLL_MS = 25
/** 单帧 body 上限（同 DAP 口径）：Content-Length 是未受信输入，防无限缓冲。 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024
const HEADER_END = Buffer.from('\r\n\r\n')

/** 服务器进程抽象（真实实现为 child_process spawn；测试可注入）。 */
type LspProcess = {
  pid?: number
  write: (data: string) => void
  onData: (handler: (chunk: string | Buffer) => void) => void
  /** 可多次注册；进程退出（含被 kill）时全部触发。 */
  onClose: (handler: () => void) => void
  kill: () => void
}

type LspSpawn = (
  binary: string,
  args: string[],
  opts: { cwd: string; label: string; env: Record<string, string> },
) => LspProcess

/** 真实 spawn：stderr 逐行进 logger.warn（服务器崩溃原因可见），stdout 归客户端。 */
const defaultSpawn: LspSpawn = (binary, args, opts) => {
  const child = childSpawn(binary, args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: opts.env,
  })
  let stderrBuf = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderrBuf += chunk
    let nl = stderrBuf.indexOf('\n')
    while (nl >= 0) {
      const line = stderrBuf.slice(0, nl).trimEnd()
      stderrBuf = stderrBuf.slice(nl + 1)
      if (line) logger.warn(`[${opts.label}] ${line}`)
      nl = stderrBuf.indexOf('\n')
    }
  })
  const closeHandlers: Array<() => void> = []
  child.on('close', () => {
    for (const h of closeHandlers) h()
  })
  return {
    pid: child.pid,
    write: (data) => child.stdin.write(data),
    onData: (h) => child.stdout.on('data', h),
    onClose: (h) => closeHandlers.push(h),
    kill: () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出：kill 抛错按已死处理
      }
    },
  }
}

type LspJsonRpcMessage = {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

type CachedDiagnostics = {
  uri: string
  version: number | null
  diagnostics: LspDiagnostic[]
  /** 全局 publish 序号（判「本次变更之后是否有新 publish」）。 */
  seq: number
  receivedAt: number
}

type OpenDoc = {
  version: number
  syncedText: string
  /** 发送最近一次 didOpen/didChange 时的全局 publish 序号。 */
  baselineSeq: number
}

type LspClientOptions = {
  server: LspServerDef
  /** 可执行文件绝对路径（servers.resolveBinary 的产物；测试可直接传 node 路径）。 */
  binary: string
  workspaceRoot: string
  spawn?: LspSpawn
  /** 追加到 process.env 的环境变量（测试控制假服务器行为）。 */
  env?: Record<string, string>
  /** 每次出站消息触发（manager 用它重置 idle 定时器）。 */
  onActivity?: () => void
}

function createLspClient(opts: LspClientOptions) {
  const { server, binary, workspaceRoot } = opts
  const spawnProcess = opts.spawn ?? defaultSpawn
  const proc = spawnProcess(binary, server.args, {
    cwd: workspaceRoot,
    label: server.name,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
  })

  const pending = createPendingRequests('LSP')
  const diagnosticsCache = new Map<string, CachedDiagnostics>()
  const openDocs = new Map<string, OpenDoc>()
  /** waitForDiagnostics 的取消钩子（dispose 时全部以 stale 收尾，不留悬挂 interval）。 */
  const waiterStops = new Set<() => void>()

  let nextId = 1
  let publishSeq = 0
  let dead = false
  let disposed = false

  const touch = (): void => opts.onActivity?.()

  proc.onClose(() => {
    if (disposed) return
    dead = true
    pending.failAll(`LSP server "${server.name}" exited unexpectedly`)
    for (const stop of waiterStops) stop()
  })

  // ── 帧编码 / 解码 ──

  const send = (msg: LspJsonRpcMessage): void => {
    const json = JSON.stringify(msg)
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`
    proc.write(header + json)
    touch()
  }

  const respond = (id: number | string, result: unknown): void => {
    send({ jsonrpc: '2.0', id, result })
  }

  let buffer = Buffer.alloc(0)

  const handleMessage = (msg: LspJsonRpcMessage): void => {
    if (msg.method !== undefined && msg.id !== undefined) {
      handleServerRequest(msg)
      return
    }
    if (msg.method !== undefined) {
      handleNotification(msg)
      return
    }
    if (msg.id !== undefined) {
      // 本客户端发出的 id 恒为 number；字符串 id（服务器自发请求的回包）找不到
      // pending，settle 静默忽略。
      pending.settle(Number(msg.id), (p) => {
        if (msg.error) {
          const data = msg.error.data === undefined ? '' : ` ${JSON.stringify(msg.error.data)}`
          p.reject(
            new Error(
              `LSP error ${msg.error.code ?? ''}: ${msg.error.message ?? 'unknown'}${data}`,
            ),
          )
        } else {
          p.resolve(msg.result)
        }
      })
    }
  }

  const handleServerRequest = (msg: LspJsonRpcMessage): void => {
    const id = msg.id as number | string
    if (msg.method === 'workspace/configuration') {
      const items = ((msg.params as { items?: Array<{ section?: string }> })?.items ??
        []) as Array<{
        section?: string
      }>
      respond(
        id,
        items.map((item) => lookupSetting(server.settings, item.section)),
      )
      return
    }
    // client/registerCapability、window/*、$/progress 相关请求一律静默回空结果。
    respond(id, null)
  }

  const handleNotification = (msg: LspJsonRpcMessage): void => {
    if (msg.method === 'textDocument/publishDiagnostics') {
      const p = msg.params as {
        uri?: string
        version?: number | null
        diagnostics?: LspDiagnostic[]
      }
      if (typeof p?.uri !== 'string') return
      diagnosticsCache.set(p.uri, {
        uri: p.uri,
        version: typeof p.version === 'number' ? p.version : null,
        diagnostics: Array.isArray(p.diagnostics) ? p.diagnostics : [],
        seq: ++publishSeq,
        receivedAt: Date.now(),
      })
      return
    }
    // exit / $/progress / window/* / telemetry 等：无需处理。
  }

  proc.onData((chunk) => {
    buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
    for (;;) {
      const headerEnd = buffer.indexOf(HEADER_END)
      if (headerEnd < 0) break
      const headerBlock = buffer.subarray(0, headerEnd).toString('ascii')
      const m = /content-length:\s*(\d+)/i.exec(headerBlock)
      if (!m) {
        logger.warn(`[${server.name}] frame without Content-Length; resyncing`)
        buffer = buffer.subarray(headerEnd + HEADER_END.length)
        continue
      }
      const len = Number(m[1])
      if (len > MAX_FRAME_BYTES) {
        logger.warn(`[${server.name}] frame of ${len} bytes exceeds cap; dropping buffer`)
        buffer = Buffer.alloc(0)
        break
      }
      const bodyStart = headerEnd + HEADER_END.length
      if (buffer.length < bodyStart + len) break
      const body = buffer.subarray(bodyStart, bodyStart + len).toString('utf8')
      buffer = buffer.subarray(bodyStart + len)
      try {
        handleMessage(JSON.parse(body) as LspJsonRpcMessage)
      } catch (e) {
        logger.warn(`[${server.name}] malformed frame body: ${errorMessage(e)}`)
      }
    }
  })

  // ── 请求 / 通知 ──

  const sendRequest = (
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> => {
    const id = nextId++
    send({ jsonrpc: '2.0', id, method, params: params ?? {} })
    return new Promise((resolve, reject) => {
      pending.add(id, { resolve, reject }, { timeoutMs, name: method })
    })
  }

  const request = (
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> => {
    if (dead || disposed) {
      // 返回 rejection（而非同步 throw）：调用方统一走 await/.catch，
      // expect(...).rejects 断言形态也成立。
      return Promise.reject(new Error(`LSP server "${server.name}" is no longer running`))
    }
    return sendRequest(method, params, timeoutMs)
  }

  const notify = (method: string, params?: unknown): void => {
    send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }

  // ── 初始化握手 ──

  const initialize = (): Promise<{ capabilities?: Record<string, unknown> }> =>
    request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'c0de-agent' },
        rootUri: pathToFileUri(workspaceRoot),
        workspaceFolders: [{ uri: pathToFileUri(workspaceRoot), name: basename(workspaceRoot) }],
        initializationOptions: server.initOptions ?? {},
        capabilities: {
          textDocumentSync: 1,
          hoverProvider: true,
          definitionProvider: true,
          typeDefinitionProvider: true,
          implementationProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          renameProvider: true,
        },
      },
      INITIALIZE_TIMEOUT_MS,
    ).then((result) => {
      notify('initialized', {})
      if (server.settings && Object.keys(server.settings).length > 0) {
        notify('workspace/didChangeConfiguration', { settings: server.settings })
      }
      return (result ?? {}) as { capabilities?: Record<string, unknown> }
    })

  // ── 文档同步（全文） ──

  const uriFor = (absPath: string): string => pathToFileUri(absPath)

  const didOpen = (absPath: string, text: string): number => {
    const uri = uriFor(absPath)
    const version = 1
    notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: languageIdForExtension(extensionOf(absPath)),
        version,
        text,
      },
    })
    openDocs.set(uri, { version, syncedText: text, baselineSeq: publishSeq })
    return version
  }

  const didChange = (absPath: string, text: string): number => {
    const uri = uriFor(absPath)
    const open = openDocs.get(uri)
    if (!open) return didOpen(absPath, text)
    open.version += 1
    open.syncedText = text
    open.baselineSeq = publishSeq
    notify('textDocument/didChange', {
      textDocument: { uri, version: open.version },
      contentChanges: [{ text }],
    })
    return open.version
  }

  const reconcileFromDisk = async (absPath: string): Promise<{ uri: string; version: number }> => {
    if (dead || disposed) throw new Error(`LSP server "${server.name}" is no longer running`)
    let text: string
    try {
      text = await readFile(absPath, 'utf8')
    } catch (e) {
      throw new Error(`LSP cannot read ${absPath}: ${errorMessage(e)}`)
    }
    const uri = uriFor(absPath)
    const open = openDocs.get(uri)
    if (!open) didOpen(absPath, text)
    else if (text !== open.syncedText) didChange(absPath, text)
    return { uri, version: (openDocs.get(uri) as OpenDoc).version }
  }

  // ── 诊断新鲜度 ──

  const diagnosticsFor = (uri: string): LspDiagnostic[] =>
    diagnosticsCache.get(uri)?.diagnostics ?? []

  const waitForDiagnostics = (
    uri: string,
    afterVersion: number,
    timeoutMs: number,
  ): Promise<{ diagnostics: LspDiagnostic[]; stale: boolean }> => {
    const baseline = openDocs.get(uri)?.baselineSeq ?? 0
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve) => {
      const finish = (result: { diagnostics: LspDiagnostic[]; stale: boolean }): void => {
        waiterStops.delete(stop)
        clearInterval(timer)
        resolve(result)
      }
      const stop = (): void => {
        const entry = diagnosticsCache.get(uri)
        finish({ diagnostics: entry?.diagnostics ?? [], stale: true })
      }
      waiterStops.add(stop)
      const timer = setInterval(() => {
        const entry = diagnosticsCache.get(uri)
        if (entry) {
          // 路径 1：服务器回显 version 且恰等于当前版本 → 立即采信。
          if (entry.version === afterVersion) {
            finish({ diagnostics: entry.diagnostics, stale: false })
            return
          }
          // 路径 2：version 未回显 → 本次变更之后收到过 publish，且静默窗口
          // 内无更新（typescript-language-server 分多次 publish 诊断）。
          if (
            entry.version === null &&
            entry.seq > baseline &&
            Date.now() - entry.receivedAt >= DIAGNOSTICS_SETTLE_MS
          ) {
            finish({ diagnostics: entry.diagnostics, stale: false })
            return
          }
        }
        if (Date.now() >= deadline) finish({ diagnostics: entry?.diagnostics ?? [], stale: true })
      }, DIAGNOSTICS_POLL_MS)
    })
  }

  // ── 生命周期 ──

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    for (const stop of Array.from(waiterStops)) stop()
    if (!dead) {
      try {
        await sendRequest('shutdown', undefined, SHUTDOWN_TIMEOUT_MS)
      } catch {
        // 服务器已退出/不响应 shutdown：直接走 kill。
      }
      notify('exit')
      await new Promise<void>((resolve) => {
        const killer = setTimeout(() => {
          proc.kill()
          resolve()
        }, EXIT_GRACE_MS)
        proc.onClose(() => {
          clearTimeout(killer)
          resolve()
        })
      })
    }
    dead = true
    proc.kill()
    pending.failAll(`LSP server "${server.name}" disposed`)
  }

  return {
    serverName: server.name,
    workspaceRoot,
    initialize,
    request,
    notify,
    didOpen,
    didChange,
    reconcileFromDisk,
    waitForDiagnostics,
    diagnosticsFor,
    isDead: () => dead || disposed,
    dispose,
  }
}

/** settings 按 dotted section 取值（workspace/configuration 应答）；无则 null。 */
function lookupSetting(
  settings: Record<string, unknown> | undefined,
  section: string | undefined,
): unknown {
  if (!settings) return null
  if (section === undefined || section === '') return settings
  let value: unknown = settings
  for (const key of section.split('.')) {
    if (typeof value !== 'object' || value === null) return null
    value = (value as Record<string, unknown>)[key]
    if (value === undefined) return null
  }
  return value ?? null
}

/**
 * definition/typeDefinition/references 返回形状归一（入参按 unknown 收——
 * 响应来自不受信的服务器进程）：Location | Location[] | LocationLink[] →
 * Location[]（LocationLink 取 targetSelectionRange ?? targetRange）。
 * null/未知形状 → []。
 */
function normalizeLocations(result: unknown): LspLocation[] {
  if (!result || typeof result !== 'object') return []
  const raw = Array.isArray(result) ? result : [result]
  const out: LspLocation[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    if ('uri' in item && item.uri) {
      out.push(item as LspLocation)
    } else if ('targetUri' in item && item.targetUri) {
      const link = item as LspLocationLink
      out.push({ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange })
    }
  }
  return out
}

export type { LspClientOptions, LspProcess, LspSpawn }
export {
  createLspClient,
  DEFAULT_REQUEST_TIMEOUT_MS,
  defaultSpawn,
  INITIALIZE_TIMEOUT_MS,
  normalizeLocations,
}
