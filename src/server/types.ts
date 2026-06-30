// src/server/types.ts
import type { Config } from '../core/config.js'
import type { DB } from '../db/client.js'
import type { chatStream as chatStreamFn } from '../llm/provider.js'
import type { Registry } from '../llm/registry.js'
import type { HookRunner, PluginRegistry } from '../plugins/types.js'
import type { Config as SharedConfig } from '../shared/types/config.js'
import type { URLRegistry } from '../shared/types/tool.js'
import type { ToolRegistry } from '../tools/types.js'
import type { AgentManager } from './agent-manager.js'
import type { PermissionStore } from './permission/store.js'

/** 持有所有服务依赖的不可变上下文（config 字段可变用于 PATCH 更新）。 */
type ServerContext = {
  db: DB
  config: Config
  toolRegistry: ToolRegistry
  llmRegistry: Registry
  /** 内置 URL 解析器注册表（file://, skill://）；注入 agent loop 的 ToolContext。 */
  urlRegistry: URLRegistry
  /** 插件 hook runner；接入 agent loop 的 tool/provider/message hook。 */
  hookRunner: HookRunner
  /** 插件注册表（builtin + 已加载外部插件）；供插件管理 API 查询。 */
  pluginRegistry: PluginRegistry
  agentManager: AgentManager
  /** 全局权限确认 store（单例），独立于 agent run 生命周期。 */
  permissionStore: PermissionStore
  /** 全局授权模式（可变，运行时切换）：'default' 逐个确认；'auto' 自动放行 ask 工具（YOLO）。不持久化，重启回 default。 */
  permissionMode: 'default' | 'auto'
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
