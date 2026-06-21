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
| UI | React 19 + haze-ui + @linaria | 用户自有组件库，零运行时 CSS |
| 存储 | Drizzle ORM + PGLite/PostgreSQL | 本地无需服务端，生产可切真 PG |
| 语言 | 纯 TypeScript | 前后端统一 |
| 包管理 | pnpm + Vite | 用户现有工具链 |
| 会话 | 多会话 + 分支 | 支持并行探索、回溯 |
| 编码范式 | data + functions | 无 class，纯 type + export function |

**参考项目**：
- pi（agent loop、harness、tools 架构）
- opencode（provider 抽象、LSP/MCP 集成、session 管理）
- oh-my-openagent（插件系统、hook 系统、工具注册）
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
  tools: { enabled: string[]; disabled: string[] }
  plugins: { enabled: string[] }
  mcpServers: MCPServerConfig[]
  theme: 'light' | 'dark' | 'system'
  locale: string
}

export function loadConfig(projectDir?: string): Promise<Config>
export function saveConfig(config: Config, scope: 'global' | 'project'): Promise<void>
export function mergeConfig(...configs: Partial<Config>[]): Config
```

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
│   ├── read.ts        文件读取
│   ├── write.ts       文件写入
│   ├── edit.ts        文件编辑（diff-based）
│   ├── bash.ts        Shell 执行
│   ├── glob.ts        文件搜索
│   ├── grep.ts        内容搜索
│   ├── lsp.ts         LSP 操作
│   ├── ast.ts         AST 搜索与编辑
│   ├── browser.ts     浏览器控制
│   ├── task.ts        子 agent
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
| `edit` | 基于 diff 的文件编辑 | ask |
| `bash` | 执行 shell 命令 | ask |
| `glob` | 按模式搜索文件名 | auto |
| `grep` | 按正则搜索文件内容 | auto |
| `lsp` | LSP 操作（定义/引用/重命名/diagnostics） | auto |
| `ast` | AST 结构搜索与编辑（基于 ast-grep） | auto |
| `browser` | 浏览器控制（Puppeteer） | ask |
| `task` | 生成子 agent 并行工作 | auto |
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
│   │   ├── CodeBlock/         代码块渲染
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

### 10.3 核心页面

**Chat 页面**（主界面）：
- 左侧：会话列表 + 分支树
- 右侧：消息流 + 输入框
- 消息流支持流式渲染、代码高亮、工具调用展开
- 工具权限确认通过弹窗交互

**Settings 页面**：
- Provider 配置（API key、base URL）
- 模型选择
- 工具启用/禁用
- 插件管理
- MCP 服务器配置
- 主题/语言设置

---

## 11. CLI 包（src/cli/）

命令行入口。

### 11.1 文件结构

```
src/cli/
├── cli.ts             主入口
├── commands/
│   ├── chat.ts        c0de chat（快速提问）
│   ├── serve.ts       c0de serve（启动 server）
│   ├── init.ts        c0de init（初始化配置）
│   ├── config.ts      c0de config（管理配置）
│   └── plugin.ts      c0de plugin（管理插件）
├── utils/
│   ├── print.ts       终端输出格式化
│   └── prompt.ts      终端交互式提示
└── index.ts
```

### 11.2 命令

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

## 14. 非功能需求

### 14.1 性能

- Agent 首次响应 < 2s（不含 LLM 延迟）
- 前端首屏加载 < 1s
- 工具执行超时：bash 300s，其他 30s

### 14.2 安全

- API key 存储在本地 keyring 或加密文件
- 工具执行沙箱化（bash 工具可选沙箱模式）
- CORS 限制本地 origin

### 14.3 可扩展性

- 插件可通过 hook 拦截和修改所有核心流程
- MCP 工具对 agent 透明，与内置工具统一接口
- Provider 可通过配置添加，无需改代码

### 14.4 可测试性

- 每个包独立可测试（mock 依赖）
- 核心 agent loop 可脱离 server 测试
- 工具可独立单元测试

---

## 15. 初始实现范围

第一版实现以下核心功能（MVP）：

1. **Core**：agent loop、prompt 构建、config 加载
2. **LLM**：OpenAI 兼容 provider（覆盖大多数场景）
3. **Tools**：read、write、edit、bash、glob、grep（6 个基础工具）
4. **Session**：单会话消息流（分支功能后续迭代）
5. **DB**：PGLite 本地存储
6. **Server**：Hono API + SSE
7. **Web**：基础聊天界面
8. **CLI**：`c0de` 和 `c0de chat` 命令

后续迭代：
- 多 provider 支持（Anthropic、Google）
- 完整工具集（LSP、AST、Browser、MCP、task、worktree）
- 多会话分支
- 插件系统
- 插件市场
