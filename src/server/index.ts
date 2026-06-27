// src/server/index.ts

export type { ActiveRun, AgentManager } from './agent-manager.js'
export { createAgentManager } from './agent-manager.js'
export { createApp } from './app.js'
export type { CreateServerContextOptions } from './context.js'
export { createServerContext } from './context.js'
export { apiError, errorHandler } from './middleware/error.js'
export type {
  InteractivePermissionChecker,
  InteractivePermissionCheckerOptions,
  PermissionRequest,
} from './permission/interactive.js'
export { createInteractivePermissionChecker } from './permission/interactive.js'
export type { RunningServer, StartServerOptions } from './server.js'
export { startServer } from './server.js'
export type {
  APIErrorBody,
  ChatRequest,
  ConfirmRequest,
  ControlRequest,
  ServerContext,
  SteerRequest,
} from './types.js'
