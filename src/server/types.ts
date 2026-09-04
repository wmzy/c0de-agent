// src/server/types.ts

import type { AgentRegistry } from '../core/agents/types.js'
import type { Config } from '../core/config.js'
import type { DB } from '../db/client.js'
import type { chatStream as chatStreamFn } from '../llm/provider.js'
import type { Registry } from '../llm/registry.js'
import type { HookRunner, PluginRegistry } from '../plugins/types.js'
import type { Config as SharedConfig } from '../shared/types/config.js'
import type { URLRegistry } from '../shared/types/tool.js'
import type { ToolRegistry } from '../tools/types.js'
import type { HandoffServer, UpdateScheduler } from '../update/index.js'
import type { AgentManager } from './agent-manager.js'
import type { AuthManager } from './auth-manager.js'
import type { PermissionStore } from './permission/store.js'
import type { PTYManager } from './terminal/pty-manager.js'

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
  /** 默认授权模式（config.permission.defaultMode）。 */
  permissionMode: 'default' | 'auto'
  /** 会话级授权模式覆盖：Map<sessionId, mode>。会话未覆盖时回退 permissionMode。
   *  P1-5：auto 是高风险状态，按会话隔离避免一个标签页切换影响全部会话。 */
  sessionPermissionModes: Map<string, 'default' | 'auto'>
  /**
   * API Bearer token（认证未显式关闭时必存在）。
   * 用户配置 security.token 优先；否则自动生成并持久化到数据目录 auth-token 文件
   * （跨重启/热更新稳定，浏览器首访经 ?token= URL 获取后本地保存）。
   * P2-16：bootstrap token 仅用于首设备注册；注册后轮换，API 请求认设备 token。
   */
  authToken?: string
  /** 认证管理器（token 轮换 + 设备配对审批，P2-16）。authEnabled=false 或测试上下文为 undefined。 */
  authManager?: AuthManager
  /** 主 HTTP 服务实际绑定端口（startServer 绑定后回填；热更新 spawn 新实例复用）。 */
  port?: number
  /** Agent 类型注册表（spec: multi-agent-design）。注入 agent loop 的 runSubAgent。 */
  agentRegistry: AgentRegistry
  /** 工作流注册表（spec: dynamic-workflow-design）。注入 /workflow slash 命令和 workflowz steering。 */
  workflowRegistry?: import('../core/workflows/registry.js').WorkflowRegistry
  /** 后台版本检查调度器（spec §18.1）；/api/update 读取其缓存结果。 */
  updateScheduler: UpdateScheduler
  /** Handoff HTTP 端点（spec §18.3）；热更新时新实例 POST /handoff 触发优雅退出。 undefined 表示未启用。 */
  handoff?: { port: number; server: HandoffServer }
  cwd: string
  /** 终端 PTY 管理器（Web 终端面板用）。 */
  ptyManager: PTYManager
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
  error: { code: string; message: string; details?: Record<string, unknown> }
}

export type {
  APIErrorBody,
  ChatRequest,
  Config,
  ConfirmRequest,
  ControlRequest,
  HandoffServer,
  ServerContext,
  SharedConfig,
  SteerRequest,
}
