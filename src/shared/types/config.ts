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

/** Server security configuration (spec §24.2). */
type SecurityConfig = {
  /** 启用 Bearer token 认证（远程访问场景）。本地开发默认关闭。 */
  authEnabled: boolean
  /** Bearer token；authEnabled 为 true 时必填。 */
  token?: string
  /** 额外允许的 CORS origin（本地回环始终允许）。 */
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
  tools: { enabled: string[]; disabled: string[] }
  plugins: { enabled: string[] }
  mcpServers: MCPServerConfig[]
  slashCommands: { enabled: string[] }
  toolMetrics: ToolMetricsConfig
  security: SecurityConfig
  websearch: WebSearchConfig
  agents: AgentsConfig
  theme: 'light' | 'dark' | 'system'
  locale: string
}

export type {
  AgentsConfig,
  CompactionConfig,
  Config,
  MCPServerConfig,
  SecurityConfig,
  ToolMetricsConfig,
  WebSearchConfig,
}
