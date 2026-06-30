/** Agent 定义的来源层级（后加载覆盖先加载）。 */
type AgentSource = 'builtin' | 'user' | 'project'

/** Agent 可见性模式：subagent=仅子用，primary=仅主，all=皆可。 */
type AgentMode = 'subagent' | 'primary' | 'all'

/** 可配置的 agent 类型定义（由 markdown frontmatter 或代码构造）。 */
interface AgentDefinition {
  /** 唯一标识，如 'researcher'。 */
  name: string
  /** 何时用此 agent（注入 task 工具描述供模型选择）。 */
  description: string
  /** 专属 system prompt（frontmatter 正文）。 */
  systemPrompt: string
  /** 允许的工具集（默认全部注册工具）。 */
  tools?: string[]
  /** 模型覆盖（默认继承父 agent）。 */
  model?: string
  /** 可见性模式。 */
  mode: AgentMode
  /** 是否用 git worktree 隔离（默认 false）。 */
  isolated?: boolean
  /** 递归派生深度上限（默认 0=禁止递归 task）。 */
  maxRecursion?: number
  /** yield 结果的 JSON Schema（验证子 agent 输出）。 */
  outputSchema?: object
  /** 来源层级。 */
  source: AgentSource
  /** markdown 路径（调试用）。 */
  filePath?: string
}

/** Agent 类型注册表：内存 Map<name, definition>。 */
interface AgentRegistry {
  register(def: AgentDefinition): void
  get(name: string): AgentDefinition | undefined
  list(mode?: AgentMode): AgentDefinition[]
  has(name: string): boolean
}

export type { AgentDefinition, AgentMode, AgentRegistry, AgentSource }
