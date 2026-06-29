// src/server/types.ts
import type { Config } from '../core/config.js'
import type { DB } from '../db/client.js'
import type { chatStream as chatStreamFn } from '../llm/provider.js'
import type { Registry } from '../llm/registry.js'
import type { Config as SharedConfig } from '../shared/types/config.js'
import type { ToolRegistry } from '../tools/types.js'
import type { AgentManager } from './agent-manager.js'
import type { PermissionStore } from './permission/store.js'

/** 持有所有服务依赖的不可变上下文（config 字段可变用于 PATCH 更新）。 */
type ServerContext = {
  db: DB
  config: Config
  toolRegistry: ToolRegistry
  llmRegistry: Registry
  agentManager: AgentManager
  /** 全局权限确认 store（单例），独立于 agent run 生命周期。 */
  permissionStore: PermissionStore
  cwd: string
  /** 测试注入：覆盖 LLM chat stream。生产环境为 undefined。 */
  chatStream?: typeof chatStreamFn
}

/** POST /api/chat 请求体。 */
type ChatRequest = {
  sessionId: string
  message: string
  provider?: string
  model?: string
  tools?: string[]
}

/** Agent 控制请求（abort/pause/resume）。 */
type ControlRequest = {
  sessionId: string
}

/** POST /api/chat/steer 请求体。 */
type SteerRequest = {
  sessionId: string
  message: string
}

/** POST /api/tools/confirm 请求体。 */
type ConfirmRequest = {
  toolCallId: string
  approved: boolean
}

/** 统一错误响应体。 */
type APIErrorBody = {
  error: { code: string; message: string }
}

export type {
  APIErrorBody,
  ChatRequest,
  Config,
  ConfirmRequest,
  ControlRequest,
  ServerContext,
  SharedConfig,
  SteerRequest,
}
