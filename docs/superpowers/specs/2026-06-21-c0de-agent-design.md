# c0de-agent 设计规格

> 可分发的开源 AI 编码助手，Browser-Server 架构，无 TUI。

## 1. 项目概述

**名称**：c0de-agent（CLI 命令：`c0de`）

**定位**：可分发的开源 AI 编码助手产品，支持多 LLM provider、完整工具集、插件系统、多会话分支。

**核心决策**：

| 决策 | 选择 | 理由 |
|------|------|------|
| 架构 | Browser-Server（无 TUI） | Web UI 更灵活，支持复杂交互 |
| LLM | 自建 provider 层 | 完全控制 streaming、tool calling、thinking blocks |
| 工具集 | 完整（file/bash/LSP/AST/browser/MCP/sub-agent/worktree） | 对标 opencode/oh-my-openagent |
| 插件 | 进程内加载 | 简单直接，开发体验好 |
| UI | React 19 + haze-ui + @linaria，PWA + 移动端优先 | 用户自有组件库，零运行时 CSS，支持移动设备 |
| 存储 | Drizzle ORM + PGLite/PostgreSQL | 本地无需服务端，生产可切真 PG |
| 语言 | 纯 TypeScript | 前后端统一 |
| 包管理 | pnpm + Vite | 用户现有工具链 |
| 会话 | 多会话 + 分支 | 支持并行探索、回溯 |
| 编码范式 | data + functions | 无 class，纯 type + export function |

**参考项目**：
- pi（agent loop、harness、tools 架构、session compaction）
- oh-my-pi（hashline、snapcompact、swarm、collab、mnemopi、Rust 核心、多 provider 路由）
- opencode（provider 抽象、LSP/MCP 集成、session 管理、worktree）
- oh-my-openagent（插件系统、hook 系统、工具注册、动态 prompt 构建）
- painless（前端技术栈：React + haze-ui + @linaria）
- anthology（后端技术栈：Hono + Drizzle + PostgreSQL）
- data-and-functions（编码范式约束）

---

## 2. 包结构

```
c0de-agent/
├── src/
│   ├── core/          agent loop、prompt 构建、config
│   ├── llm/           provider 抽象、streaming、token 计费
│   ├── tools/         工具注册、执行框架、内置工具
│   ├── mcp/           MCP 协议客户端
│   ├── plugins/       插件加载、生命周期、hook 系统
│   ├── session/       会话持久化、分支管理
│   ├── db/            Drizzle schema、PGLite/PostgreSQL
│   ├── server/        Hono API + WebSocket
│   ├── web/           React 前端
│   └── cli/           c0de 命令入口
├── package.json
├── tsconfig.base.json
├── pnpm-workspace.yaml
└── biome.json
```

### 2.1 依赖方向

```
cli ──→ core ──→ llm
  │       │
  │       ├──→ tools ──→ mcp
  │       │
  │       ├──→ plugins
  │       │
  │       └──→ session ──→ db
  │
  └──→ server ──→ core + session + db

web ←──(HTTP/WS)──→ server
```

依赖方向单向，禁止循环依赖。每个包是 pnpm workspace member，独立 `package.json`。

---

## 3. Core 包（src/core/）

Agent 核心循环与配置管理。

### 3.1 文件结构

```
src/core/
├── agent.ts           agent loop
├── prompt.ts          system prompt 构建
├── config.ts          配置加载与合并
├── context.ts         token 预算与消息裁剪
├── types.ts           核心类型
└── index.ts           公开 API
```

### 3.2 核心类型

```typescript
type AgentConfig = {
  provider: string
  model: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  tools: string[]         // 启用的工具名列表
  plugins: string[]       // 启用的插件名列表
}

type AgentState = {
  session: Session
  messages: Message[]
  tools: ToolDef[]
  tokenBudget: TokenBudget
  abortController: AbortController
  status: AgentStatus      // 运行状态（idle/running/paused/error）
  steeringQueue: string[]  // steering 消息队列
  llmDetails: LLMDetail[]  // LLM 调用详情记录
}

type AgentEvent =
  | { _tag: 'text_delta'; text: string }
  | { _tag: 'tool_call'; id: string; tool: string; input: unknown }
  | { _tag: 'tool_result'; id: string; tool: string; output: ToolResult }
  | { _tag: 'thinking'; text: string }
  | { _tag: 'usage'; input: number; output: number }
  | { _tag: 'error'; error: AgentError }
  | { _tag: 'permission_required'; toolCallId: string; tool: string; input: unknown }
  | { _tag: 'done' }
```

### 3.3 核心函数

```typescript
export function createAgent(config: AgentConfig): AgentState
export function runAgent(state: AgentState, message: Message): AsyncGenerator<AgentEvent>
export function abortAgent(state: AgentState): void
```

`runAgent` 返回 `AsyncGenerator<AgentEvent>`，内部流程：

1. 构建 system prompt（注入工具描述、项目上下文、技能）
2. 调用 `llm.chatStream()` 获取流式响应
3. 遍历 `StreamChunk`：
   - `text` → yield `AgentEvent.text_delta`
   - `tool_call` → 检查权限 → 执行工具 → yield 事件 → 将工具结果追加到消息 → 回到步骤 2
   - `thinking` → yield `AgentEvent.thinking`
   - `usage` → yield `AgentEvent.usage`
4. 循环直到 LLM 返回结束信号或达到 max iterations

### 3.4 Prompt 构建

`prompt.ts` 负责组装 system prompt：

```typescript
type PromptContext = {
  tools: ToolDef[]
  projectInfo: ProjectInfo
  skills: Skill[]
  config: AgentConfig
}

export function buildSystemPrompt(ctx: PromptContext): string
```

System prompt 包含：
- 基础角色描述
- 工具列表及其 JSON Schema 参数描述
- 项目上下文（文件结构、git 状态、语言等）
- 已加载的技能描述
- 编码范式约束（data + functions）

### 3.5 配置管理

配置分三层合并（后者覆盖前者）：

1. 内置默认值
2. 全局配置 `~/.c0de/config.json`
3. 项目配置 `.c0de/config.json`

```typescript
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
  theme: 'light' | 'dark' | 'system'
  locale: string
}

export function loadConfig(projectDir?: string): Promise<Config>
export function saveConfig(config: Config, scope: 'global' | 'project'): Promise<void>
export function mergeConfig(...configs: Partial<Config>[]): Config
```

### 3.6 上下文管理

`context.ts` 管理 token 预算和消息裁剪：

```typescript
type TokenBudget = {
  total: number          // context window 大小
  reserved: number       // 预留给 system prompt + 工具描述
  available: number      // total - reserved
  used: number           // 当前已用
  keepRecent: number     // 保留最近 N 条消息原文
}

type CompactionConfig = {
  enabled: boolean
  threshold: number      // 触发压缩的 token 使用率（如 0.8）
  reserveTokens: number  // 压缩后保留的 token 空间
  keepRecentTokens: number // 保留最近消息的 token 数
}
```

**策略**：
1. **Token 预算分配**：system prompt + 工具描述占 20%，历史消息占 60%，当前轮次占 20%
2. **滑动窗口**：当消息超出预算，从最旧的非系统消息开始丢弃
3. **Compaction**：当 token 使用率超过阈值，将旧消息压缩为摘要（调用 LLM 生成摘要，替换原始消息）

```typescript
export function estimateTokens(text: string): number
export function shouldCompact(messages: Message[], budget: TokenBudget, config: CompactionConfig): boolean
export function compactMessages(messages: Message[], config: CompactionConfig): Promise<Message[]>
export function fitToBudget(messages: Message[], budget: TokenBudget): Message[]
```

### 3.7 Agent 生命周期 Hook

Agent loop 在关键节点触发 hook，插件可拦截和修改行为：

```typescript
type AgentHookMap = {
  'before_tool_call': { tool: string; input: unknown; ctx: ToolContext }
  'after_tool_call': { tool: string; input: unknown; result: ToolResult; ctx: ToolContext }
  'before_provider_request': { request: ChatRequest }
  'after_provider_response': { chunks: StreamChunk[] }
  'session:create': { session: Session }
  'session:fork': { source: Session; fork: Session }
  'message:before': { messages: Message[] }
  'message:after': { message: Message }
}
```

Hook 执行规则：
- `before_*` hook 可修改输入参数或返回 `false` 拦截操作
- `after_*` hook 可修改输出结果
- 多个 hook 按注册顺序链式执行
- hook 超时 5s 自动跳过

### 3.8 Slash 命令

```typescript
type SlashCommand = {
  name: string           // 命令名（不含 /）
  description: string
  args?: JSONSchema      // 可选参数 schema
  execute: (args: unknown, ctx: CommandContext) => Promise<CommandResult>
}

type CommandContext = {
  agent: AgentState
  session: Session
  config: Config
}
```

内置命令：

| 命令 | 描述 |
|------|------|
| `/compact` | 手动触发上下文压缩 |
| `/model <name>` | 切换当前会话模型 |
| `/clear` | 清空当前会话消息 |
| `/help` | 列出可用命令 |
| `/fork [messageIndex]` | 从指定消息处创建分支 |
| `/config <key> [value]` | 查看/设置配置 |

### 3.9 Steering 消息

Agent 执行过程中，用户可注入系统消息纠正行为：

```typescript
export function injectSteeringMessage(state: AgentState, message: string): void
```

Steering 消息插入到消息流的当前位置，作为系统角色消息传给 LLM。不影响历史消息，只影响当前轮次的行为。

前端通过 WebSocket 推送 steering 消息，agent loop 在下一次 LLM 调用前检查 steering 队列。

### 3.10 内部 URL Scheme

统一资源访问，`read` 和 `search` 工具支持多种 URL scheme：

| Scheme | 描述 | 示例 |
|--------|------|------|
| `file://` 或无前缀 | 本地文件 | `src/main.ts` |
| `skill://` | 技能文件 | `skill://brainstorming` |
| `agent://` | 子 agent 输出 | `agent://Task1` |
| `pr://` | GitHub PR | `pr://123` |
| `issue://` | GitHub Issue | `issue://456` |

```typescript
type URLResolver = {
  scheme: string
  resolve(url: string, ctx: ResolveContext): Promise<string>  // 返回内容
}

export function registerURLResolver(registry: URLRegistry, resolver: URLResolver): void
export function resolveURL(registry: URLRegistry, url: string, ctx: ResolveContext): Promise<string>
```

工具执行时，如果输入匹配已注册的 URL scheme，自动调用对应的 resolver 获取内容。

---

## 4. LLM 包（src/llm/）

Provider 抽象与 streaming。

### 4.1 文件结构

```
src/llm/
├── provider.ts        provider 注册与管理
├── types.ts           Provider、Model、ChatRequest、ChatResponse
├── stream.ts          streaming 协议抽象
├── protocol/
│   ├── openai.ts      OpenAI Chat Completions + Responses API
│   ├── anthropic.ts   Anthropic Messages API
│   ├── google.ts      Gemini API
│   └── openai-compat.ts  OpenAI 兼容适配器
├── token.ts           token 计数与成本估算
├── models.ts          模型能力注册表
└── index.ts
```

### 4.2 类型所有权

LLM 包定义协议级类型（`ChatMessage`、`ChatTool`、`StreamChunk`），Core 包定义会话级类型（`Message`、`ToolDef`）。Core 负责将 `Message` 转换为 `ChatMessage` 后传给 LLM。

### 4.3 Provider 抽象

```typescript
type ProviderConfig = {
  _tag: 'openai' | 'anthropic' | 'google' | 'openai-compat'
  apiKey: string
  baseURL?: string
  models?: Record<string, ModelOverride>
}

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  toolCallId?: string
  toolCalls?: { id: string; name: string; arguments: string }[]
}

type ChatTool = {
  name: string
  description: string
  parameters: JSONSchema
}

type ChatRequest = {
  model: string
  messages: ChatMessage[]
  tools?: ChatTool[]
  stream: true
  maxTokens?: number
  temperature?: number
  system?: string
}

type StreamChunk =
  | { _tag: 'text'; text: string }
  | { _tag: 'tool_call'; id: string; name: string; args: string }
  | { _tag: 'thinking'; text: string }
  | { _tag: 'usage'; input: number; output: number }
  | { _tag: 'done' }

type ProviderRegistry = {
  providers: Map<string, ProviderInstance>
}

export function createProviderRegistry(configs: ProviderConfig[]): ProviderRegistry
export function chatStream(
  registry: ProviderRegistry,
  request: ChatRequest
): AsyncGenerator<StreamChunk>
```

### 4.4 Protocol 实现

每个 protocol 文件实现统一接口：

```typescript
type ProtocolHandler = {
  name: string
  chat(request: ChatRequest, config: ProviderConfig): AsyncGenerator<StreamChunk>
  listModels?(config: ProviderConfig): Promise<Model[]>
}
```

- **openai.ts**：OpenAI Chat Completions API + Responses API，SSE 解析
- **anthropic.ts**：Anthropic Messages API，支持 extended thinking、prompt caching
- **google.ts**：Gemini API，支持多模态
- **openai-compat.ts**：OpenAI 兼容适配器，覆盖 DeepSeek、Groq、Together 等

### 4.6 多角色路由

不同任务路由到不同模型，节省成本：

```typescript
type ModelRole =
  | { readonly _tag: 'default' }   // 通用任务
  | { readonly _tag: 'smol' }      // 简单快速（便宜模型）
  | { readonly _tag: 'slow' }      // 复杂推理（强模型）
  | { readonly _tag: 'plan' }      // 规划任务
  | { readonly _tag: 'commit' }    // 提交消息生成

type RoleRouting = Record<ModelRole['_tag'], { provider: string; model: string }>

export function resolveModel(registry: ProviderRegistry, role: ModelRole): { provider: string; model: string }
```

配置示例：
```json
{
  "roleRouting": {
    "default": { "provider": "openai", "model": "gpt-4.1" },
    "smol": { "provider": "openai", "model": "gpt-4.1-mini" },
    "slow": { "provider": "anthropic", "model": "claude-sonnet-4" },
    "plan": { "provider": "anthropic", "model": "claude-sonnet-4" },
    "commit": { "provider": "openai", "model": "gpt-4.1-mini" }
  }
}
```

### 4.7 Provider Fallback

Provider 失败时自动切换备用：

```typescript
type FallbackChain = {
  primary: string        // 主 provider
  fallbacks: string[]    // 备用 provider 列表
  retryDelay: number     // 重试间隔（ms）
  maxRetries: number     // 每个 provider 最大重试次数
}

export function chatStreamWithFallback(
  registry: ProviderRegistry,
  request: ChatRequest,
  chain: FallbackChain
): AsyncGenerator<StreamChunk>
```

Fallback 触发条件：
- HTTP 429（限流）
- HTTP 5xx（服务端错误）
- 网络超时
- API key 无效

### 4.5 模型能力注册表

```typescript
type ModelCapabilities = {
  contextWindow: number
  maxOutput: number
  supportsTools: boolean
  supportsVision: boolean
  supportsThinking: boolean
  costPer1kInput: number
  costPer1kOutput: number
}

export function getModelCapabilities(model: string): ModelCapabilities
export function registerModel(model: string, caps: ModelCapabilities): void
```

---

## 5. Tools 包（src/tools/）

工具注册、执行与内置工具。

### 5.1 文件结构

```
src/tools/
├── registry.ts        工具注册表
├── executor.ts        工具执行器
├── types.ts           ToolDef、ToolResult、ToolPermission
├── builtin/
│   ├── read.ts        文件读取（支持内部 URL）
│   ├── write.ts       文件写入
│   ├── edit.ts        文件编辑（hashline + diff 双模式）
│   ├── bash.ts        Shell 执行
│   ├── glob.ts        文件搜索
│   ├── grep.ts        内容搜索
│   ├── ast_grep.ts    AST 结构搜索（tree-sitter，50+ 语言）
│   ├── ast_edit.ts    AST 结构编辑（语法感知重写）
│   ├── lsp.ts         LSP 操作
│   ├── browser.ts     浏览器控制
│   ├── task.ts        子 agent（worktree 隔离）
│   ├── worktree.ts    Git worktree 管理
│   └── websearch.ts   网络搜索
└── index.ts
```

### 5.2 工具抽象

```typescript
type ToolDef = {
  name: string
  description: string
  parameters: JSONSchema
  permission: ToolPermission
  execute: ToolExecutor
}

type ToolPermission = 'auto' | 'ask' | 'deny'

type ToolResult =
  | { _tag: 'success'; output: string; metadata?: Record<string, unknown> }
  | { _tag: 'error'; error: string }
  | { _tag: 'permission_required'; reason: string }

type ToolExecutor = (input: unknown, ctx: ToolContext) => Promise<ToolResult>

type SessionRef = {
  id: string
  cwd: string
}

type ToolContext = {
  cwd: string
  session: SessionRef
  abort: AbortSignal
}
```

### 5.3 工具注册与执行

```typescript
export function createToolRegistry(): ToolRegistry
export function registerTool(registry: ToolRegistry, tool: ToolDef): void
export function listTools(registry: ToolRegistry): ToolDef[]
export function getTool(registry: ToolRegistry, name: string): ToolDef | undefined

export function executeTool(
  registry: ToolRegistry,
  name: string,
  input: unknown,
  ctx: ToolContext
): Promise<ToolResult>
```

`executor.ts` 执行流程：
1. 查找工具定义
2. 验证输入参数（JSON Schema validation）
3. 检查权限（`deny` → 拒绝，`ask` → 返回 `permission_required`，`auto` → 继续）
4. 执行工具函数
5. 格式化结果

### 5.4 内置工具描述

| 工具 | 描述 | 权限 |
|------|------|------|
| `read` | 读取文件内容，支持行范围选择 | auto |
| `write` | 创建或覆盖文件 | ask |
| `edit` | 文件编辑（支持 hashline 和 diff 两种模式） | ask |
| `bash` | 执行 shell 命令 | ask |
| `glob` | 按模式搜索文件名 | auto |
| `grep` | 按正则搜索文件内容 | auto |
| `ast_grep` | AST 结构搜索（基于 tree-sitter，50+ 语言） | auto |
| `ast_edit` | AST 结构编辑（预览后应用，语法感知重写） | ask |
| `lsp` | LSP 操作（定义/引用/重命名/diagnostics） | auto |
| `browser` | 浏览器控制（Puppeteer） | ask |
| `task` | 生成子 agent 并行工作（worktree 隔离） | auto |
| `worktree` | Git worktree 管理（隔离工作区） | ask |
| `websearch` | 网络搜索 | auto |

---

## 6. MCP 包（src/mcp/）

MCP 协议客户端，将外部工具服务器的工具适配为内部 ToolDef。

### 6.1 文件结构

```
src/mcp/
├── client.ts          MCP 客户端
├── transport.ts       传输层（stdio、SSE、HTTP）
├── types.ts           MCP 协议类型
├── tool-adapter.ts    MCP tool → ToolDef 适配
└── index.ts
```

### 6.2 核心接口

```typescript
type MCPServerConfig = {
  name: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
}

export function connectMCPServer(config: MCPServerConfig): Promise<MCPSession>
export function discoverTools(session: MCPSession): ToolDef[]
export function callMCPTool(session: MCPSession, name: string, args: unknown): Promise<ToolResult>
export function disconnectMCPServer(session: MCPSession): void
```

MCP 工具通过 `tool-adapter.ts` 转换为内部 `ToolDef`，注册到工具注册表中，对 agent 透明。

---

## 7. Plugins 包（src/plugins/）

进程内插件系统。

### 7.1 文件结构

```
src/plugins/
├── loader.ts          插件发现与加载
├── registry.ts        插件注册表
├── lifecycle.ts       生命周期管理
├── hooks.ts           hook 系统
├── types.ts           Plugin、PluginContext、HookDefinition
└── index.ts
```

### 7.2 插件定义

```typescript
type Plugin = {
  name: string
  version: string
  setup: (ctx: PluginContext) => void | Promise<void>
}

type PluginContext = {
  registerTool: (tool: ToolDef) => void
  registerProvider: (provider: ProviderConfig) => void
  registerHook: <T>(hook: string, handler: HookHandler<T>) => void
  getConfig: () => Config
  getLogger: (name: string) => Logger
}
```

### 7.3 Hook 系统

```typescript
type HookHandler<T> = (data: T) => T | Promise<T>

// 内置 hook 点
type HookMap = {
  'tool:before': { tool: string; input: unknown }
  'tool:after': { tool: string; input: unknown; result: ToolResult }
  'session:create': { session: Session }
  'message:before': { messages: Message[] }
  'config:resolve': { config: Config }
}

export function registerHook<K extends keyof HookMap>(
  registry: PluginRegistry,
  hook: K,
  handler: HookHandler<HookMap[K]>
): void

export function runHooks<K extends keyof HookMap>(
  registry: PluginRegistry,
  hook: K,
  data: HookMap[K]
): Promise<HookMap[K]>
```

### 7.4 插件加载

插件来源：
1. 项目目录 `.c0de/plugins/` 下的本地插件
2. npm 包（`c0de-plugin-*` 命名约定）
3. 全局 `~/.c0de/plugins/` 目录

```typescript
export function discoverPlugins(projectDir: string): Promise<Plugin[]>
export function loadPlugin(path: string): Promise<Plugin>
export function activatePlugin(plugin: Plugin, ctx: PluginContext): Promise<void>
export function deactivatePlugin(plugin: Plugin): Promise<void>
```

---

## 8. Session + DB 包

### 8.1 DB 包（src/db/）

Drizzle ORM 数据库层。

```
src/db/
├── schema.ts          Drizzle schema
├── client.ts          PGLite/PostgreSQL 客户端
├── migrate.ts         迁移执行
└── index.ts
```

#### Schema

```typescript
// sessions 表
type SessionRow = {
  id: string              // uuid
  title: string
  parentId: string | null // 分支父会话
  branchPoint: number | null // 分支点消息索引
  metadata: JSONB         // 扩展元数据
  createdAt: timestamp
  updatedAt: timestamp
}

// messages 表
type MessageRow = {
  id: string              // uuid
  sessionId: string       // FK → sessions.id
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: JSONB          // 结构化内容
  tokenCount: number
  createdAt: timestamp
}

// configs 表
type ConfigRow = {
  key: string             // PK
  value: JSONB
}
```

#### 客户端

```typescript
type DB = {
  driver: 'pglite' | 'postgres'
  db: DrizzleDB
}

export function createDB(config: DBConfig): Promise<DB>
export function migrate(db: DB): Promise<void>

type DBConfig =
  | { driver: 'pglite'; dataDir?: string }
  | { driver: 'postgres'; connectionString: string }
```

PGLite 模式数据存储在 `~/.c0de/data/` 目录。

### 8.2 Session 包（src/session/）

会话管理与分支。

```
src/session/
├── session.ts         会话 CRUD
├── message.ts         消息操作
├── branch.ts          分支管理
├── types.ts           类型定义
└── index.ts
```

#### 会话操作

```typescript
export function createSession(db: DB, title: string): Session
export function getSession(db: DB, id: string): Session | null
export function listSessions(db: DB): Session[]
export function deleteSession(db: DB, id: string): void
export function updateSessionTitle(db: DB, id: string, title: string): void
```

#### 消息操作

```typescript
export function appendMessage(db: DB, sessionId: string, message: Message): Message
export function getMessages(db: DB, sessionId: string, opts?: { limit?: number; offset?: number }): Message[]
export function getMessageCount(db: DB, sessionId: string): number
export function deleteMessagesAfter(db: DB, sessionId: string, messageIndex: number): void
```

#### 分支管理

```typescript
export function forkSession(db: DB, sessionId: string, messageIndex: number): Session
export function getBranches(db: DB, sessionId: string): Session[]
export function getTree(db: DB): SessionTreeNode[]
```

分支模型：`forkSession` 创建新会话，复制目标消息之前的所有消息到新会话，通过 `parentId` 和 `branchPoint` 形成树结构。

---

## 9. Server 包（src/server/）

Hono HTTP/WebSocket 服务。

### 9.1 文件结构

```
src/server/
├── app.ts             Hono 应用入口
├── routes/
│   ├── session.ts     会话 CRUD API
│   ├── chat.ts        聊天流式 API（SSE）
│   ├── tool.ts        工具管理 API
│   ├── config.ts      配置 API
│   └── health.ts      健康检查
├── ws.ts              WebSocket 推送
├── middleware/
│   ├── auth.ts        认证中间件
│   ├── cors.ts        CORS
│   └── error.ts       错误处理
└── index.ts
```

### 9.2 API 路由

```
POST   /api/sessions              创建会话
GET    /api/sessions              列出会话
GET    /api/sessions/:id          获取会话详情
POST   /api/sessions/:id/fork     分支会话
DELETE /api/sessions/:id          删除会话
GET    /api/sessions/:id/messages 获取消息列表

POST   /api/chat                  发送消息（SSE 流式返回）
POST   /api/chat/abort            中止当前 agent

GET    /api/tools                 列出可用工具
POST   /api/tools/:name/confirm   确认工具执行

GET    /api/config                获取配置
PATCH  /api/config                更新配置

GET    /api/health                健康检查

GET    /api/files                  浏览目录（?path=相对路径）
GET    /api/files/:path            读取文件内容
PUT    /api/files/:path            写入文件
GET    /api/files/search           搜索文件（?q=关键词）
GET    /api/files/:path/raw        原始文件内容（用于预览/下载）
```

### 9.3 SSE 流式聊天

`POST /api/chat` 使用 Server-Sent Events 流式返回 agent 事件：

```
event: text_delta
data: {"text": "让我"}

event: text_delta
data: {"text": "查看"}

event: tool_call
data: {"id": "tc_1", "tool": "read", "input": {"path": "src/main.ts"}}

event: tool_result
data: {"id": "tc_1", "tool": "read", "output": {"_tag": "success", "output": "..."}}

event: usage
data: {"input": 1500, "output": 200}

event: done
data: {}
```

### 9.4 WebSocket 推送

WebSocket 用于双向通信：
- **Server → Client**：agent 事件、工具执行进度、后台任务状态
- **Client → Server**：工具权限确认、会话切换、配置更新

---

## 10. Web 包（src/web/）

React 前端。

### 10.1 文件结构

```
src/web/
├── src/
│   ├── views/
│   │   ├── Chat/              主聊天界面
│   │   ├── SessionList/       会话列表（含分支树）
│   │   ├── Settings/          配置页面
│   │   └── Layout/            布局组件
│   ├── components/
│   │   ├── MessageBubble/     消息气泡
│   │   ├── ToolCall/          工具调用展示
│   │   ├── BranchTree/        分支可视化
│   │   ├── CodeBlock/         代码块渲染 + 引用
│   │   ├── FileBrowser/       文件浏览器
│   │   ├── FilePreview/       文件预览（图片/MD/PDF/代码）
│   │   ├── CodeEditor/        代码编辑器（Monaco/CodeMirror）
│   │   ├── PermissionDialog/  工具权限确认弹窗
│   │   └── StreamingIndicator/ 流式输入指示器
│   ├── services/
│   │   ├── chat.ts            聊天 API 客户端
│   │   ├── session.ts         会话 API 客户端
│   │   └── ws.ts              WebSocket 客户端
│   ├── hooks/
│   │   ├── useChat.ts         聊天状态管理
│   │   ├── useSession.ts      会话状态管理
│   │   └── useAgent.ts        agent 状态管理
│   ├── styles/
│   │   └── global.ts          全局样式（@linaria）
│   ├── App.tsx
│   └── main.tsx
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

### 10.2 技术栈

- React 19
- haze-ui 组件库
- @linaria 零运行时 CSS
- @native-router/react 路由
- @tanstack/react-query 数据获取
- Vite 构建

### 10.3 PWA + 移动端优先

Web 前端作为 PWA 构建，支持移动端安装和使用：

**PWA 要求**：
- `manifest.json` 配置应用图标、主题色、启动 URL
- Service Worker 缓存静态资源，支持离线访问
- 支持 `beforeinstallprompt` 事件，引导用户安装
- 响应式布局，移动端优先设计

**移动端优先设计原则**：
- 断点：mobile（< 768px）→ tablet（768-1024px）→ desktop（> 1024px）
- 默认样式为移动端，通过 `@media (min-width)` 适配大屏
- 触摸友好的交互（按钮最小 44px、滑动手势、长按菜单）
- 底部导航栏（移动端）→ 侧边栏（桌面端）
- 聊天界面全屏沉浸式，输入框固定在底部
- 工具调用详情可折叠/展开

**移动端特有功能**：
- 语音输入（Web Speech API）
- 推送通知（Push API）——agent 完成任务时通知
- 分享目标（Web Share API）——从其他应用分享文本到 c0de

### 10.4 核心页面

**Chat 页面**（主界面）：
- 左侧：会话列表 + 分支树 + 文件浏览器
- 右侧：消息流 + 输入框
- 消息流支持流式渲染、代码高亮、工具调用展开
- 工具权限确认通过弹窗交互

**文件浏览器**：
- 树形目录结构，支持展开/折叠
- 点击文件在右侧预览面板打开
- 支持在线编辑（Monaco Editor 或 CodeMirror）
- 文件变更实时反映（WebSocket 推送）
- 搜索文件名和内容
- git 状态标记（新增/修改/删除）

**特殊文件渲染**：
- 图片：内联预览（PNG/JPEG/GIF/SVG/WebP）
- Markdown：渲染为富文本（支持 mermaid 图表）
- JSON/YAML：语法高亮 + 折叠
- PDF：内联查看器
- 代码：语法高亮 + 行号 + 折叠
- 音频/视频：内联播放器

**代码块引用**：
- 消息中的代码块可被引用（点击引用按钮或拖拽）
- 引用格式：`@[path:startLine-endLine]` 或 `@[messageId:blockIndex]`
- 引用的代码块在消息中渲染为可折叠的代码片段
- 点击引用可跳转到文件浏览器中的对应位置
- agent 可以通过引用自动获取代码上下文

```typescript
type CodeReference = {
  _tag: 'file'
  path: string
  startLine: number
  endLine: number
} | {
  _tag: 'message'
  messageId: string
  blockIndex: number
}
```

**Settings 页面**：
- Provider 配置（API key、base URL）
- 模型选择
- 工具启用/禁用
- 插件管理
- MCP 服务器配置
- 主题/语言设置

---

## 11. CLI 包（src/cli/）

命令行入口与多运行模式。

### 11.1 文件结构

```
src/cli/
├── cli.ts             主入口
├── commands/
│   ├── chat.ts        c0de chat（快速提问）
│   ├── serve.ts       c0de serve（启动 server）
│   ├── init.ts        c0de init（初始化配置）
│   ├── config.ts      c0de config（管理配置）
│   ├── plugin.ts      c0de plugin（管理插件）
│   └── acp.ts         c0de acp（ACP 模式）
├── modes/
│   ├── print.ts       Print 模式（一次性输出）
│   └── acp.ts         ACP 模式（编辑器集成）
├── utils/
│   ├── print.ts       终端输出格式化
│   └── prompt.ts      终端交互式提示
└── index.ts
```

### 11.2 运行模式

| 模式 | 命令 | 描述 |
|------|------|------|
| **Server** | `c0de` 或 `c0de serve` | 启动 HTTP/WS 服务 + 打开浏览器 |
| **Print** | `c0de chat "问题"` | 一次性输出结果，适合脚本和快速提问 |
| **ACP** | `c0de acp` | Agent Client Protocol，JSON-RPC over stdin/stdout，供编辑器集成 |

#### Print 模式

```typescript
export function runPrintMode(config: Config, message: string, opts: PrintOptions): Promise<string>

type PrintOptions = {
  model?: string
  format: 'text' | 'json'
  maxTokens?: number
}
```

Print 模式启动一个临时 agent，发送消息，等待完整响应后输出到 stdout 并退出。

#### ACP 模式

Agent Client Protocol（参考 oh-my-pi）：JSON-RPC over stdin/stdout，让编辑器（VS Code、Neovim 等）能与 c0de 通信。

```typescript
type ACPRequest =
  | { method: 'chat'; params: { message: string; sessionId?: string } }
  | { method: 'tool/confirm'; params: { toolCallId: string; approved: boolean } }
  | { method: 'session/list'; params: {} }
  | { method: 'session/create'; params: { title?: string } }
  | { method: 'abort'; params: {} }

type ACPResponse =
  | { result: { text: string } }
  | { result: { sessionId: string } }
  | { result: { sessions: Session[] } }
  | { error: { code: number; message: string } }
```

ACP 事件通过 `event` 消息推送（与 agent event 对应）。

### 11.3 命令

| 命令 | 描述 |
|------|------|
| `c0de` | 启动 server + 打开浏览器 |
| `c0de chat "问题"` | 快速提问（终端输出） |
| `c0de serve` | 只启动 server |
| `c0de init` | 初始化 `.c0de/config.json` |
| `c0de config get [key]` | 查看配置 |
| `c0de config set key value` | 设置配置 |
| `c0de plugin list` | 列出插件 |
| `c0de plugin install <name>` | 安装插件 |

---

## 12. 数据流

### 12.1 完整请求流程

```
用户在 Web UI 输入消息
  ↓
useChat hook → POST /api/chat (SSE)
  ↓
Server chat route → core.runAgent(state, message)
  ↓
Core agent loop:
  1. prompt.buildSystemPrompt(ctx)
  2. llm.chatStream(registry, request)
  3. 遍历 StreamChunk:
     - text → yield AgentEvent.text_delta
     - tool_call → 检查权限 → 执行工具 → yield 事件 → 追加结果 → 回到 2
     - thinking → yield AgentEvent.thinking
     - usage → yield AgentEvent.usage
  4. 循环直到结束
  ↓
Server SSE 推送 AgentEvent 到前端
  ↓
useChat hook 更新 UI（流式渲染）
```

### 12.2 工具权限确认流程

```
Agent loop 遇到 permission: 'ask' 的工具
  ↓
yield AgentEvent.permission_required
  ↓
Server 通过 WebSocket 推送到前端
  ↓
前端弹出 PermissionDialog
  ↓
用户确认/拒绝
  ↓
前端调用 POST /api/tools/:name/confirm
  ↓
Server 恢复 agent loop 执行
```

### 12.3 子 Agent 流程

```
Agent loop 遇到 task 工具调用
  ↓
tools.executeTool('task', { prompt, ... })
  ↓
task 工具内部:
  1. 创建新 session（session.createSession）
  2. 创建新 agent state（core.createAgent）
  3. 运行 core.runAgent（独立循环）
  4. 收集结果返回
  ↓
结果回传给父 agent 继续
```

---

## 13. 编码范式约束

所有代码遵循 data + functions 范式（参考 data-and-functions 项目）：

1. **数据用 `type`**，不用 `interface`、不用 `enum`
2. **行为用 `export function`**，第一个参数是上下文
3. **禁止 `class`、`new`、`this`、`obj.method()`**
4. **创建用 `create*` / `make*`**，不变量在构造器内 enforce
5. **变体用 `_tag` + 分发函数**，不用 `instanceof`
6. **封装用模块级 WeakMap**，不 export 私有访问器
7. **上下文允许原地修改**，不强制不可变
8. **框架适配层最小化**，核心逻辑保持 data + functions

---

## 16. Hashline 编辑

内容哈希锚定的补丁语言，替代普通 diff 实现更安全的文件编辑。

### 16.1 概念

每个编辑块绑定文件内容的 4 位哈希。如果文件在 agent 思考期间被修改，旧锚点的哈希不匹配，编辑会被拒绝而不是错误应用。

### 16.2 格式

```
[PATH#HASH]
SWAP lineStart-lineEnd
new content here
---
```

操作类型：
- `SWAP`：替换指定行范围
- `DEL`：删除指定行
- `INS.PRE` / `INS.POST`：在指定行前/后插入
- `INS.HEAD` / `INS.TAIL`：在文件头/尾插入
- `SWAP.BLK` / `DEL.BLK` / `INS.BLK.POST`：基于语法块的操作（AST 感知）

### 16.3 核心函数

```typescript
type ParsedPatch = {
  path: string
  hash: string
  operations: PatchOp[]
}

type ApplyResult =
  | { _tag: 'success'; content: string }
  | { _tag: 'hash_mismatch'; expected: string; actual: string }
  | { _tag: 'line_not_found'; operation: PatchOp }

export function parsePatch(input: string): ParsedPatch[]
export function applyPatch(file: string, patch: ParsedPatch): ApplyResult
export function computeHash(content: string): string  // 4 位 hex
```

### 16.4 与 edit 工具集成

`edit` 工具支持两种编辑模式：

1. **Diff 模式**：标准的 search/replace 文本替换，所有模型都能良好生成
2. **Hashline 模式**：内容哈希锚定的补丁，更安全但依赖模型能力

配置中可设置默认模式，也可在每次调用时通过参数切换：

```typescript
type EditMode =
  | { _tag: 'diff'; search: string; replace: string }
  | { _tag: 'hashline'; patch: string }
```

### 16.5 模型能力评估

系统根据模型历史表现自动选择最优工具模式：

```typescript
type ModelToolMetrics = {
  model: string
  tool: string
  mode: string
  attempts: number
  successes: number
  failures: number
  avgLatency: number
  lastUsed: number
}

export function recordToolResult(metrics: ModelToolMetrics[], result: ToolResult): void
export function selectBestMode(metrics: ModelToolMetrics[], model: string, tool: string): string
export function getMetrics(db: DB, model: string, tool: string): ModelToolMetrics
```

**评估逻辑**：
- 每次工具执行后记录成功/失败到 DB
- `selectBestMode` 查找该 model+tool 组合的历史成功率
- 优先选择成功率 > 80% 的模式
- 新模型或数据不足时使用保守默认值（diff 模式）
- 用户可覆盖自动选择，强制使用指定模式

这个机制不限于 edit 工具——任何有多种实现方式的工具都可以注册模式评估：
- `edit`：diff vs hashline
- `bash`：直接执行 vs 沙箱执行
- `read`：全文读取 vs 分块读取

---

## 17. AST 工具（ast_grep + ast_edit）

基于 tree-sitter 的结构化代码搜索和编辑，支持 50+ 编程语言。

### 17.1 ast_grep — 结构搜索

用 AST 模式匹配代码，比正则更精确：

```typescript
type ASTGrepResult = {
  file: string
  range: { start: { line: number; column: number }; end: { line: number; column: number } }
  match: string        // 匹配的代码文本
  captures: Record<string, string>  // 捕获的变量
}

export function astGrep(pattern: string, paths: string[], opts?: ASTGrepOptions): ASTGrepResult[]

type ASTGrepOptions = {
  language?: string    // 强制指定语言
  include?: string[]   // 文件 glob 过滤
  exclude?: string[]   // 排除 glob
  maxResults?: number
}
```

示例：
- `astGrep('console.log($$$ARGS)', ['src/**/*.ts'])` — 找所有 console.log 调用
- `astGrep('function $NAME($$$ARGS) { $$$BODY }', ['src/**/*.ts'])` — 找所有函数声明
- `astGrep('import { $$$IMPORTS } from "$PKG"', ['src/**/*.ts'])` — 找特定包的导入

### 17.2 ast_edit — 结构编辑

用 AST 模式匹配 + 模板替换实现语法感知的代码重写：

```typescript
type ASTEditOp = {
  pattern: string      // 匹配模式
  replacement: string  // 替换模板（可用捕获变量）
}

type ASTEditResult = {
  file: string
  changes: { original: string; replacement: string; range: Range }[]
  preview: string      // 完整文件预览
}

export function astEdit(ops: ASTEditOp[], paths: string[], opts?: ASTEditOptions): ASTEditResult[]
export function applyASTEdit(result: ASTEditResult): void
```

**安全机制**：
- 默认只生成预览（`preview` 字段），不直接修改文件
- 用户确认后调用 `applyASTEdit` 应用变更
- 支持 dry-run 模式，输出 diff 预览
- 多文件编辑原子性：要么全部应用，要么全部回滚

示例：
- `astEdit([{ pattern: 'console.log($$$ARGS)', replacement: 'logger.info($$$ARGS)' }], ['src/**/*.ts'])` — 批量替换 console.log
- `astEdit([{ pattern: 'class $NAME { $$$BODY }', replacement: 'export function create$NAME() { $$$BODY }' }], ['src/**/*.ts'])` — OOP 到 data+functions 重构

---

## 17. 动态 Prompt 构建

运行时根据当前可用能力动态组装 system prompt，替代静态模板。

### 17.1 原理

```typescript
type PromptSection = {
  id: string
  title: string
  content: string
  priority: number       // 排序优先级
  condition?: (ctx: PromptBuildContext) => boolean  // 条件渲染
}

type PromptBuildContext = {
  tools: ToolDef[]
  agents: AgentDef[]
  skills: Skill[]
  plugins: Plugin[]
  config: Config
  session: Session
}

export function buildDynamicPrompt(ctx: PromptBuildContext): string
export function registerPromptSection(registry: PromptRegistry, section: PromptSection): void
```

### 17.2 内置 Section

| Section | 条件 | 内容 |
|---------|------|------|
| `role` | 始终 | 基础角色描述 |
| `tools` | 有工具时 | 工具列表及参数 |
| `skills` | 有技能时 | 技能描述和调用方式 |
| `agents` | 有子 agent 时 | 可委托的 agent 列表 |
| `project` | 有项目上下文时 | 文件结构、git 状态 |
| `constraints` | 始终 | 编码范式约束 |
| `slash-commands` | 始终 | 可用命令列表 |

插件可通过 `registerPromptSection` 注入自定义 section。

---

---

## 18. 热更新 + 会话迁移

自动检查新版本，无缝升级而不丢失会话。

### 18.1 流程

```
1. 后台定期检查 npm registry 新版本
2. 发现新版本 → 通知前端（可选自动/手动确认）
3. 下载并安装新版本
4. 序列化当前会话状态到临时文件
5. 启动新实例，传入会话状态文件路径
6. 新实例加载会话状态，恢复所有活跃会话
7. 新实例接管 server 端口（旧实例 graceful shutdown）
8. 前端自动重连到新实例
```

### 18.2 核心函数

```typescript
type UpdateCheckResult = {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  releaseNotes?: string
}

type SessionSnapshot = {
  version: string
  sessions: SessionState[]
  agentStates: AgentStateSnapshot[]
  config: Config
  timestamp: number
}

export function checkForUpdate(): Promise<UpdateCheckResult>
export function serializeSessionState(state: AgentState): SessionSnapshot
export function restoreSessionState(snapshot: SessionSnapshot): Promise<AgentState>
export function performHotUpdate(snapshot: SessionSnapshot): Promise<void>
```

### 18.3 端口接管

新实例启动时检测端口占用：
- 如果旧实例仍在运行，通过 IPC 通知旧实例 graceful shutdown
- 旧实例序列化状态后退出
- 新实例绑定端口，加载状态
- 前端 WebSocket 自动重连

---

## 19. 暂停/恢复 Agent Loop

用户可以暂停正在执行的 agent，查看状态后恢复或中止。

### 19.1 状态机

```
idle → running → paused → running（恢复）
                → idle（中止）
```

### 19.2 核心函数

```typescript
export function pauseAgent(state: AgentState): void
export function resumeAgent(state: AgentState): void
export function isAgentPaused(state: AgentState): boolean
export function getAgentStatus(state: AgentState): AgentStatus

type AgentStatus =
  | { _tag: 'idle' }
  | { _tag: 'running'; currentTool?: string; messageCount: number }
  | { _tag: 'paused'; pauseReason: string; resumeAvailable: boolean }
  | { _tag: 'error'; error: AgentError }
```

### 19.3 暂停时可执行操作

- 查看当前消息历史
- 查看正在执行的工具及其输入
- 注入 steering 消息（恢复后生效）
- 中止 agent
- 恢复执行

前端通过 WebSocket 接收状态变更事件，在 UI 上显示暂停状态和操作按钮。

---

## 20. 透明可观察

完整暴露 LLM 调用细节，包括 prompt、token 用量、延迟。

### 20.1 观察数据

每次 LLM 调用记录：

```typescript
type LLMDetail = {
  id: string
  timestamp: number
  model: string
  provider: string
  role: ModelRole

  // 输入
  systemPrompt: string      // 完整 system prompt
  messages: ChatMessage[]    // 完整消息历史
  tools: ChatTool[]          // 发送的工具定义

  // 输出
  responseChunks: StreamChunk[]  // 完整响应流
  thinking?: string              // thinking 内容

  // 元数据
  usage: { input: number; output: number; cacheHit?: number }
  latency: { firstToken: number; total: number }
  cost: number
}
```

### 20.2 观察 API

```
GET /api/sessions/:id/llm-details        获取会话的所有 LLM 调用详情
GET /api/sessions/:id/llm-details/:callId 获取单次调用详情
```

### 20.3 前端展示

会话详情页包含「调用详情」tab：
- 按时间线展示每次 LLM 调用
- 可展开查看完整 system prompt、消息历史、工具定义
- 显示 token 用量、延迟、成本
- 响应流可回放（逐 chunk 查看）

---

## 21. DAP 集成

Debug Adapter Protocol 支持，让 agent 能控制调试器。

### 18.1 DAP 客户端

```
src/tools/
├── dap.ts             DAP 工具（设断点、单步、查看变量）
└── ...
```

```typescript
type DAPSession = {
  adapter: string      // 调试适配器名称（如 'node', 'python'）
  program: string      // 被调试程序
  state: 'running' | 'paused' | 'stopped'
}

type Breakpoint = {
  file: string
  line: number
  condition?: string
}

export function startDebugSession(config: DAPConfig): Promise<DAPSession>
export function setBreakpoint(session: DAPSession, bp: Breakpoint): Promise<void>
export function continue(session: DAPSession): Promise<void>
export function stepOver(session: DAPSession): Promise<void>
export function stepIn(session: DAPSession): Promise<void>
export function stepOut(session: DAPSession): Promise<void>
export function getStackTrace(session: DAPSession): Promise<StackFrame[]>
export function getVariables(session: DAPSession, frameId: number): Promise<Variable[]>
export function evaluate(session: DAPSession, expression: string): Promise<string>
export function stopDebugSession(session: DAPSession): void
```

### 18.2 DAP 工具

DAP 暴露为一组工具，agent 可以自然地使用调试能力：

| 工具 | 描述 | 权限 |
|------|------|------|
| `debug_start` | 启动调试会话 | ask |
| `debug_breakpoint` | 设置断点 | auto |
| `debug_continue` | 继续执行 | auto |
| `debug_step` | 单步执行（over/in/out） | auto |
| `debug_stack` | 查看调用栈 | auto |
| `debug_vars` | 查看变量 | auto |
| `debug_eval` | 求值表达式 | auto |
| `debug_stop` | 停止调试 | auto |

---

## 24. 非功能需求

### 24.1 性能

- Agent 首次响应 < 2s（不含 LLM 延迟）
- 前端首屏加载 < 1s
- 工具执行超时：bash 300s，其他 30s

### 24.2 安全

- API key 存储在本地 keyring 或加密文件
- 工具执行沙箱化（bash 工具可选沙箱模式）
- CORS 限制本地 origin

### 24.3 可扩展性

- 插件可通过 hook 拦截和修改所有核心流程
- MCP 工具对 agent 透明，与内置工具统一接口
- Provider 可通过配置添加，无需改代码

### 24.4 可测试性

- 每个包独立可测试（mock 依赖）
- 核心 agent loop 可脱离 server 测试
- 工具可独立单元测试

---

## 25. 初始实现范围

第一版实现以下核心功能（MVP）：

1. **Core**：agent loop（支持暂停/恢复）、prompt 构建（动态 prompt）、config 加载、上下文管理（滑动窗口 + compaction）、生命周期 hook、steering 消息
2. **LLM**：OpenAI 兼容 provider、角色路由、fallback 链
3. **Tools**：read（支持内部 URL）、write、edit（hashline）、bash、glob、grep、task（worktree 隔离）
4. **Session**：单会话消息流、compaction、分支功能、LLM 调用详情记录（透明可观察）
5. **DB**：PGLite 本地存储
6. **Server**：Hono API + SSE + WebSocket
7. **Web**：基础聊天界面、slash 命令支持、LLM 调用详情展示
8. **CLI**：`c0de`、`c0de chat`（Print 模式）、`c0de acp`（ACP 模式）
9. **Plugins**：插件加载框架 + hook 系统
10. **DAP**：调试器集成（基础 DAP 客户端）
11. **Update**：热更新 + 会话迁移

后续迭代：
- 完整工具集（LSP、AST、Browser、MCP）
- 多 provider 支持（Anthropic、Google 原生协议）
- 插件市场
- 技能发现（从 .claude/.cursor 等目录继承）
- 记忆引擎
- 实时协作
- 多 agent 编排（Swarm）
- 统计面板
