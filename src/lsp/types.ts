// LSP 协议子集：类型词表 + 纯函数（URI 换算、扩展名→languageId 映射）。
// 本文件零依赖、零 IO——client.ts 持进程/帧 IO，servers.ts 持二进制定位，
// manager.ts 持生命周期；tools/builtin/lsp.ts 只消费这一层的类型与换算。
// 位置语义：LSP line/character 均为 0-based、character 按 UTF-16 code unit
// 计——JS string 原生即 UTF-16，行切分后可直接用 char 索引，无需换算。

import { fileURLToPath, pathToFileURL } from 'node:url'

type LspPosition = { line: number; character: number }
type LspRange = { start: LspPosition; end: LspPosition }
type LspLocation = { uri: string; range: LspRange }
type LspLocationLink = {
  originSelectionRange?: LspRange
  targetUri: string
  targetRange: LspRange
  targetSelectionRange?: LspRange
}
type LspDiagnosticSeverity = 1 | 2 | 3 | 4
type LspDiagnostic = {
  range: LspRange
  severity?: LspDiagnosticSeverity
  code?: number | string
  source?: string
  message: string
}
/** textDocument/publishDiagnostics 的缓存条目。version 为 null 表示服务器
 *  未回显版本（如 typescript-language-server，见 client.ts 采信策略）。 */
type LspPublishedDiagnostics = {
  uri: string
  version: number | null
  diagnostics: LspDiagnostic[]
}
type LspDocumentSymbol = {
  name: string
  detail?: string
  kind: number
  range: LspRange
  selectionRange: LspRange
  children?: LspDocumentSymbol[]
}
type LspSymbolInformation = {
  name: string
  kind: number
  location: LspLocation
  containerName?: string
}
type LspTextEdit = { range: LspRange; newText: string }
type LspTextDocumentEdit = {
  textDocument: { uri: string; version?: number | null }
  edits: LspTextEdit[]
}
/** 资源操作（create/rename/delete 文件）——lsp_rename 仅支持文本编辑。 */
type LspResourceOperation = { kind: 'create' | 'rename' | 'delete' } & Record<string, unknown>
type LspDocumentChange = LspTextDocumentEdit | LspResourceOperation
type LspWorkspaceEdit = {
  changes?: Record<string, LspTextEdit[]>
  documentChanges?: LspDocumentChange[]
}

/** 解析后的完整服务器定义（内置默认表 ⊕ config.lsp.servers 浅合并，见 servers.ts）。 */
type LspServerDef = {
  name: string
  command: string
  args: string[]
  /** 服务的文件扩展名（不含点）。 */
  fileTypes: string[]
  /** workspaceRoot 判定的标记文件（从目标文件向上找首个命中目录）。 */
  rootMarkers: string[]
  initOptions?: Record<string, unknown>
  settings?: Record<string, unknown>
}

/** reconcileFromDisk 的返回：didOpen/didChange 之后的文档版本与 URI。 */
type LspReconcileResult = { uri: string; version: number }

/** waitForDiagnostics 的返回：stale=true 表示超时采信的缓存（可能过期）。 */
type LspFreshness = { diagnostics: LspDiagnostic[]; stale: boolean }

/**
 * LSP 客户端（单服务器进程 + 单 workspaceRoot）。didOpen/didChange 为全文
 * 同步（textDocumentSync=1）；进程退出后标记 dead，由 manager 负责重启。
 */
type LspClient = {
  serverName: string
  workspaceRoot: string
  /** initialize 握手（initialize → initialized → didChangeConfiguration）。 */
  initialize: () => Promise<{ capabilities?: Record<string, unknown> }>
  /** 发 JSON-RPC 请求并等待响应（pending 走 shared/jsonrpc-pending）。 */
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  notify: (method: string, params?: unknown) => void
  /** didOpen（version 1）。 */
  didOpen: (absPath: string, text: string) => number
  /** didChange 全文同步（version+1）。 */
  didChange: (absPath: string, text: string) => number
  /** 磁盘内容未同步时推送 didOpen/didChange；返回当前 uri/version。 */
  reconcileFromDisk: (absPath: string) => Promise<LspReconcileResult>
  /** 等待新鲜诊断：version 精确命中，或（version 未回显）settle 静默窗口。 */
  waitForDiagnostics: (
    uri: string,
    afterVersion: number,
    timeoutMs: number,
  ) => Promise<LspFreshness>
  /** 当前缓存诊断（可能过期，新鲜度由 waitForDiagnostics 判定）。 */
  diagnosticsFor: (uri: string) => LspDiagnostic[]
  isDead: () => boolean
  dispose: () => Promise<void>
}

/** 扩展名（小写、无点）→ LSP languageId。未命中回退 plaintext。 */
const EXTENSION_LANGUAGE_IDS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  py: 'python',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
}

function languageIdForExtension(ext: string): string {
  return EXTENSION_LANGUAGE_IDS[ext.toLowerCase()] ?? 'plaintext'
}

/** 取路径扩展名（小写、无点）；无扩展名返回空串。 */
function extensionOf(absPath: string): string {
  const base = absPath.replaceAll('\\', '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

function pathToFileUri(absPath: string): string {
  return pathToFileURL(absPath).href
}

/** file:// URI → 路径。容忍宽松服务器发原始路径 / 未编码 URI。 */
function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  try {
    return fileURLToPath(uri)
  } catch {
    return decodeURIComponent(uri.replace(/^file:\/\//, ''))
  }
}

export type {
  LspClient,
  LspDiagnostic,
  LspDiagnosticSeverity,
  LspDocumentChange,
  LspDocumentSymbol,
  LspFreshness,
  LspLocation,
  LspLocationLink,
  LspPosition,
  LspPublishedDiagnostics,
  LspRange,
  LspReconcileResult,
  LspResourceOperation,
  LspServerDef,
  LspSymbolInformation,
  LspTextDocumentEdit,
  LspTextEdit,
  LspWorkspaceEdit,
}
export { EXTENSION_LANGUAGE_IDS, extensionOf, languageIdForExtension, pathToFileUri, uriToPath }
