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
  /** 并行子 agent 数上限，默认 3。 */
  subagentConcurrency: number
}

/** 权限配置：控制工具执行授权的默认行为。 */
type PermissionConfig = {
  /**
   * 启动时的默认授权模式：
   * - 'default'（默认）：只读工具自动放行；写/执行工具需确认。Web 为交互弹窗；
   *   CLI 非交互（`c0de chat` 未加 -y）下写/执行工具直接拒绝并提示加 -y 或改 auto。
   *   （`c0de acp` 恒为 full-auto，由编辑器侧自行控制执行授权，不受本项影响。）
   * - 'auto'：全部工具自动放行（YOLO）。克隆仓库前务必先审查其 .c0de/config.json。
   */
  defaultMode: 'default' | 'auto'
  /**
   * 权限确认超时（提示后 25 分钟宽限期满）兜底拒绝后的动作：
   * - 'pause'（默认）：拒绝该工具并暂停 run，用户回来点「恢复」继续——
   *   避免 default 模式下 agent 在用户缺席时继续自主执行后续工具；
   * - 'deny'：拒绝该工具，run 继续执行（旧行为，会话绝不挂起）。
   */
  timeoutAction?: 'pause' | 'deny'
  /** 首层确认超时（毫秒）——超过仅提示、pending 保持；默认 5 分钟。 */
  timeoutMs?: number
  /** 首层超时后到兜底自动拒绝的宽限期（毫秒）；默认 25 分钟。 */
  expireGraceMs?: number
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
  /** 首设备 bootstrap token 有效期（毫秒）。bootstrap 自生成（auth-token 文件
   *  mtime）起超过此时长即拒绝首设备注册。未设置时默认 5 分钟（auth-manager 内置）；
   * 无已注册设备时每次 serve 都会重新生成 bootstrap，故重启即可恢复注册。
   *  用于共享主机等 URL 可能泄漏的场景，缩短「先到先得」竞态窗口。 */
  firstDeviceTtlMs?: number
}

/** 用量与成本统计配置。 */
type UsageConfig = {
  /** 月度成本预算（USD，按配置价目估算）。0 = 不限制。
   *  项目口径：当前项目聚合成本超过预算时告警/暂停。
   *  当前月成本超过预算时，设置页「用量」面板给出醒目告警。 */
  monthlyBudgetUsd: number
  /**
   * 全局月度成本预算（USD，所有项目 + 未归属调用聚合）。0 = 不限制。
   *  P1-3：与项目预算并存，任一超支即触发 budgetAction——
   *  未归属项目/未配置项目预算的花费至少受全局预算兜底。
   *  仅 global 作用域生效：项目作用域写入会被剥离并忽略（作用域收敛）。 */
  globalMonthlyBudgetUsd?: number
  /**
   * 月度 token 预算（input + output + cacheRead tokens 之和），0 = 不限制。
   *  P0：价格独立护栏——自建网关/未登记模型的 cost 恒 $0，金额护栏拦不住，
   *  token 护栏按 token 量兜底（缓存读取亦按用量计费，故纳入口径）。
   *  动作由 tokenBudgetAction 决定（缺省回退 budgetAction，向后兼容）。 */
  monthlyTokenBudget?: number
  /**
   * 全局月度 token 预算（所有项目 + 未归属调用聚合），0 = 不限制。
   *  与 monthlyTokenBudget 并存，任一超支即按 tokenBudgetAction 触发。
   *  仅 global 作用域生效（与 globalMonthlyBudgetUsd 同口径）。 */
  globalMonthlyTokenBudget?: number
  /**
   * 超支动作（P3 成本护栏），作用于**金额**预算：
   * - 'warn'（默认）：仅告警（顶栏徽标/用量面板），agent 继续执行；
   * - 'pause'：新一轮 LLM 请求前发现当月成本超预算 → 暂停 run（等同权限超时
   *   暂停机制），用户点「恢复」后本 run 不再因预算重复暂停（用户已知情）；
   * - 'abort'：新一轮 LLM 请求前发现超预算 → 中止 run（硬封顶，无「恢复」按钮，
   *   需重新发送消息/调高预算后重试），适合需要「撞线即硬停、不可在界面原地放行」的场景。
   */
  budgetAction?: 'warn' | 'pause' | 'abort'
  /**
   * token 预算的超支动作，独立于金额预算（P：token 是兜底口径，用户可能希望
   * 「金额超支暂停、token 超支只告警」或反之）。缺省回退 budgetAction。
   * 语义同 budgetAction：'pause'/'abort' 硬性暂停/中止，'warn' 仅徽标/面板告警。
   */
  tokenBudgetAction?: 'warn' | 'pause' | 'abort'
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
  usage: UsageConfig
  theme: 'light' | 'dark' | 'system'
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
  UsageConfig,
  WebSearchConfig,
}
