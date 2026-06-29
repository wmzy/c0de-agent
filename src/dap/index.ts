// DAP 包（spec §21）：DAP 客户端、会话管理、进程 transport。

export type { DAPClient, DAPMessage, DAPTransport } from './protocol.js'
export {
  createDAPClient,
  createFramer,
  encodeMessage,
} from './protocol.js'
export type { DebugSessionManager, DebugSpawn } from './session.js'
export { createDebugSessionManager, dapVariables } from './session.js'
export { createProcessTransport } from './transport.js'
export type {
  Breakpoint,
  DAPConfig,
  DAPSession,
  DebugStartInput,
  StackFrame,
  Variable,
} from './types.js'
