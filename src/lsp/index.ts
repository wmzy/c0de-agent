// LSP 包导出面：types（协议词表+纯换算）、servers（定义解析与二进制定位）、
// client（进程+帧+同步）、manager（生命周期）。

export type { LspProcess, LspSpawn } from './client.js'
export { createLspClient, normalizeLocations } from './client.js'
export type { LspManager, LspManagerOptions } from './manager.js'
export { createLspManager, defaultLspManager } from './manager.js'
export {
  BUILTIN_LSP_SERVERS,
  findWorkspaceRoot,
  pickServersForFile,
  resolveBinary,
  resolveServers,
} from './servers.js'
export type {
  LspClient,
  LspDiagnostic,
  LspDocumentSymbol,
  LspLocation,
  LspLocationLink,
  LspPosition,
  LspRange,
  LspServerDef,
  LspSymbolInformation,
  LspTextEdit,
  LspWorkspaceEdit,
} from './types.js'
export { extensionOf, languageIdForExtension, pathToFileUri, uriToPath } from './types.js'
