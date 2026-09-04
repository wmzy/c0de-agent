import type { ProviderConfig } from './llm.js'

/** MCP server configuration. */
type MCPServerConfig = {
  name: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
}

/** Context compaction configuration. */
type CompactionConfig = {
  enabled: boolean
  /** Token usage ratio that triggers compaction (e.g. 0.8 = 80%). */
  threshold: number
  /** Token space to reserve after compaction. */
  reserveTokens: number
  /** Token budget for retaining recent messages verbatim. */
  keepRecentTokens: number
  /** 中轮压缩（mid-run compaction）：单个 turn 内工具执行后、下一次 LLM 请求前
   * 按阈值静默压缩。与 turn-end 自动压缩独立——以本开关为闸门复用 shouldCompact
   * 的阈值逻辑（不受 `enabled` 影响），默认关闭（保守开启）。 */
  midTurnEnabled?: boolean
  /** 压缩摘要使用的模型覆盖。未设置时回退到会话主模型。
   * 摘要任务对推理能力要求低，可指定便宜/快速模型以降低成本。 */
  compactionModel?: { provider: string; model: string }
}

/** Tool-mode auto-selection configuration (spec §16.5). */
type ToolMetricsConfig = {
  enabled: boolean
  /** Minimum success ratio to prefer a mode (e.g. 0.8 = 80%). */
  threshold: number
  /** Minimum sample count before trusting a mode's success ratio. */
  minSamples: number
}

/** Web 搜索配置（见 docs/superpowers/specs/2026-06-30-websearch-tool-design.md）。 */
type WebSearchConfig = {
  /** 后端选择。'auto'（默认）→ 按 key 可用性：tavily > brave > duckduckgo。 */
  provider: 'auto' | 'duckduckgo' | 'tavily' | 'brave'
  /** Tavily key；也可由环境变量 TAVILY_API_KEY 提供（环境变量优先）。 */
  tavilyApiKey?: string
  /** Brave key；也可由环境变量 BRAVE_API_KEY 提供（环境变量优先）。 */
  braveApiKey?: string
}

/** 多 agent 配置（spec: multi-agent-design §4.12）。 */
type AgentsConfig = {
  /** agent markdown 目录（相对项目根），默认 '.c0de/agents'。 */
  dir: string
  /** 并行子 agent 数上限，默认 3。 */
  subagentConcurrency: number
}

/** 权限配置：控制工具执行授权的默认行为。 */
type PermissionConfig = {
  /** 启动时的默认授权模式：'default' 逐个确认（默认）；'auto' 自动放行 ask 工具（YOLO 自动授权）。 */
  defaultMode: 'default' | 'auto'
}

/** 自动升级配置（spec §18）。控制后台 npm registry 检查与无感知热更新行为。 */
type UpdateConfig = {
  /** 启用后台定期版本检查（默认 true）。 */
  enabled: boolean
  /** 检查间隔（毫秒），默认 1 小时。 */
  intervalMs: number
  /** 启动后首次检查的延迟（毫秒），默认 10 秒。 */
  initialDelayMs: number
  /** 热更新前暂停活跃 run 的等待超时（毫秒），默认 30 秒。
   *  暂停会等当前原子操作（工具执行）完成；超时仍未暂停的 run 将被强制中止。 */
  pauseTimeoutMs?: number
  /** 手动安装等待程序文件变更的超时（毫秒），默认 10 分钟。 */
  manualWaitTimeoutMs?: number
}

/** Server security configuration (spec §24.2)。 */
type SecurityConfig = {
  /**
   * 是否启用 Bearer token 认证（默认 true）。
   * 关闭为显式选择（可信网络/无人值守场景），会取消一切 API 鉴权。
   */
  authEnabled: boolean
  /** Bearer token；未提供时服务端自动生成并持久化到全局数据目录（跨重启/热更新稳定）。 */
  token?: string
  /** 额外允许的 CORS origin（本地回环始终允许；局域网/远程访问需显式添加）。 */
  allowedOrigins: string[]
}

/** Global application configuration. */
type Config = {
  providers: ProviderConfig[]
  defaultProvider: string
  defaultModel: string
  roleRouting: Record<string, { provider: string; model: string }>
  fallback: { enabled: boolean; maxRetries: number; retryDelay: number }
  compaction: CompactionConfig
  /** 一键提交使用的独立模型。未设置时回退到 defaultProvider/defaultModel。
   * commit message 生成对推理能力要求低，可指定便宜/快速模型以降低成本。 */
  commitModel?: { provider: string; model: string }
  tools: { enabled: string[]; disabled: string[] }
  plugins: { enabled: string[] }
  mcpServers: MCPServerConfig[]
  slashCommands: { enabled: string[] }
  toolMetrics: ToolMetricsConfig
  security: SecurityConfig
  websearch: WebSearchConfig
  agents: AgentsConfig
  permission: PermissionConfig
  update: UpdateConfig
  theme: 'light' | 'dark' | 'system'
  locale: string
}

export type {
  AgentsConfig,
  CompactionConfig,
  Config,
  MCPServerConfig,
  PermissionConfig,
  SecurityConfig,
  ToolMetricsConfig,
  UpdateConfig,
  WebSearchConfig,
}
