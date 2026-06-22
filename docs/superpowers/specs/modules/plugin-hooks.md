# Plugin & Hook 系统详细设计

> 基于 oh-my-openagent 和 oh-my-pi 的实现分析。

## 1. 参考项目分析

### 1.1 Oh-My-OpenAgent

**架构**：内部 hook 系统 → PluginInterface → Hooks → Tools

**PluginInterface**（11 个 SDK hook 点）：
- `chat.params`：修改聊天请求参数
- `chat.headers`：修改请求头
- `chat.message`：修改消息
- `event`：接收 agent 事件
- `command.execute.before`：命令执行前
- `tool.definition`：修改工具定义
- `tool.execute.before`：工具执行前拦截
- `tool.execute.after`：工具执行后处理
- `config`：配置解析
- `messages.transform`：消息转换
- `system.transform`：system prompt 转换

**Hook 系统**（50+ hook 模块，7 个层级）：
1. **Core**：session-recovery、model-fallback、runtime-fallback
2. **Transform**：compaction-context-injector、directory-agents-injector、team-mailbox-injector
3. **Tool-Guard**：write-existing-file-guard、webfetch-redirect-guard、notepad-write-guard
4. **Message**：ralph-loop、atlas
5. **Event**：team-session-events、session-notification
6. **Disposable**：claude-code-hooks、comment-checker、auto-slash-command
7. **Interactive-Bash**：bash 相关 hook

**Tool Registry**（~40 工具工厂）：
- 优先级排序（`LOW_PRIORITY_TOOL_ORDER` 数组，26 个工具名）
- 团队模式条件注册
- 多类别工具分类

**Hook 执行**：
- `before_*` hook：同步执行，可修改输入或返回 `false` 拦截
- `after_*` hook：异步执行，fire-and-forget
- Hook 通过配置文件启用/禁用
- Hook 优先级决定执行顺序

### 1.2 Oh-My-Pi

**架构**：三层模型——Plugins → Extensions → Hooks

**Extensions**（最强大）：
- 完整运行时访问
- 注册工具、slash 命令、快捷键、CLI 标志
- 通过 `pi.on()` 订阅事件
- 获取 `ExtensionContext`：model registry、system prompt 访问、shutdown 等
- UI 原语：TUI 组件、设置面板 tab

**Hooks**（中等功能）：
- 通过 `pi.on()` 订阅生命周期事件
- 更窄的 API 表面
- 工具包装器用于拦截

**Plugins**（npm 包）：
- `package.json` 的 `omp` 字段声明元数据
- 包含 tools、hooks、extensions、commands、settings schema
- PluginManager 处理 npm install、验证、feature 选择、settings schema
- 项目级覆盖通过 `.omp/config.yml`

**事件类型**（`shared-events.ts`，306 行）：
- `session_start` / `session_end`
- `tool_call` / `tool_result`
- `message_before` / `message_after`
- `provider_request` / `provider_response`
- `compaction_before` / `compaction_after`
- `config_change`
- `shutdown`

**Hook Runner**：
- 同步执行 `before_*` 事件（可拦截）
- 异步执行 `after_*` 事件（fire-and-forget）
- 超时保护（5s 默认）
- 错误隔离（单个 hook 失败不影响其他）

---

## 2. c0de-agent Plugin & Hook 设计

### 2.1 架构

采用 oh-my-pi 的三层模型，简化实现：

```
src/plugins/
├── types.ts           类型定义
├── plugin.ts          Plugin 管理器
├── extension.ts       Extension 管理器
├── hooks/
│   ├── registry.ts    Hook 注册表
│   ├── runner.ts      Hook 执行器
│   ├── builtin/       内置 hook
│   │   ├── tool-guard.ts
│   │   ├── session-hook.ts
│   │   └── message-hook.ts
│   └── index.ts
├── loader.ts          插件/扩展发现与加载
├── context.ts         ExtensionContext 构建
└── index.ts
```

### 2.2 三层定义

#### Plugin（npm 包）

```typescript
type PluginManifest = {
  name: string
  version: string
  description: string
  c0de: {
    tools?: string[]           // 提供的工具名
    hooks?: string[]           // 注册的 hook 文件路径
    extensions?: string[]      // 注册的扩展文件路径
    commands?: string[]        // 注册的 slash 命令
    settings?: JSONSchema      // 插件配置 schema
  }
}

type Plugin = {
  manifest: PluginManifest
  path: string                 // 安装路径
  status: 'installed' | 'loaded' | 'active' | 'error'
}
```

#### Extension（TypeScript 模块）

```typescript
type Extension = {
  name: string
  version: string
  setup: (ctx: ExtensionContext) => void | Promise<void>
  dispose?: () => void | Promise<void>
}

type ExtensionContext = {
  // 工具注册
  registerTool: (tool: ToolDef) => void
  registerSlashCommand: (cmd: SlashCommand) => void

  // Provider 注册
  registerProvider: (provider: ProviderConfig) => void

  // 事件订阅
  on: <K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>) => void

  // 配置
  getConfig: () => Config
  getPluginConfig: (pluginName: string) => unknown

  // 系统访问
  getSystemPrompt: () => string
  setSystemPromptExtension: (ext: string) => void

  // 日志
  getLogger: (name: string) => Logger

  // 生命周期
  onDispose: (handler: () => void | Promise<void>) => void
}
```

#### Hook（TypeScript 模块）

```typescript
type Hook = {
  name: string
  priority: number             // 执行优先级（越小越先执行）
  events: string[]             // 订阅的事件列表
  setup: (api: HookAPI) => void
}

type HookAPI = {
  on: <K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>) => void
  getConfig: () => Config
  getLogger: (name: string) => Logger
}
```

### 2.3 事件系统

```typescript
type EventMap = {
  // Agent 生命周期
  'agent:start': { session: Session; config: AgentConfig }
  'agent:end': { session: Session; duration: number }

  // LLM 调用
  'provider:before_request': { request: ChatRequest }
  'provider:after_response': { response: StreamChunk[]; usage: Usage }
  'provider:error': { error: ProviderError }

  // 工具执行
  'tool:before_execute': { tool: string; input: unknown; ctx: ToolContext }
  'tool:after_execute': { tool: string; input: unknown; result: ToolResult; duration: number }

  // 消息
  'message:before_send': { messages: Message[] }
  'message:after_receive': { message: Message }

  // Session
  'session:create': { session: Session }
  'session:fork': { source: Session; fork: Session }
  'session:compact': { before: number; after: number }

  // 配置
  'config:change': { key: string; old: unknown; new: unknown }

  // 系统
  'shutdown': {}
}

type EventHandler<T> = (data: T) => void | T | Promise<void | T>
```

**事件处理规则**：
- `before_*` 事件：handler 返回修改后的数据（链式传递），返回 `false` 表示拦截
- `after_*` 事件：handler 返回值被忽略（fire-and-forget）
- 多个 handler 按 priority 排序链式执行

### 2.4 Hook 执行器

```typescript
type HookRunner = {
  // 注册 hook
  register(hook: Hook): void

  // 触发事件（同步，可拦截）
  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): EventMap[K] | false

  // 触发事件（异步，fire-and-forget）
  emitAsync<K extends keyof EventMap>(event: K, data: EventMap[K]): Promise<void>

  // 清理
  dispose(): Promise<void>
}

export function createHookRunner(): HookRunner
```

**执行流程**：
```
emit('tool:before_execute', data)
  → 按 priority 排序已注册的 handlers
  → 同步执行每个 handler
  → 如果 handler 返回 false → 中止，返回 false
  → 如果 handler 返回修改后的 data → 传递给下一个 handler
  → 全部执行完 → 返回最终 data
```

**超时保护**：每个 handler 执行超时 5s，超时自动跳过并记录警告。

### 2.5 内置 Hook

#### Tool Guard

| Hook | 描述 |
|------|------|
| `write-existing-file-guard` | 写入已有文件时确认 |
| `webfetch-redirect-guard` | Web fetch 重定向安全检查 |
| `notepad-write-guard` | Notepad 写入保护 |
| `tool-pair-validator` | 验证工具调用配对（如 read 必须在 edit 之前） |
| `bash-file-read-guard` | Bash 文件读取保护 |
| `edit-error-recovery` | 编辑错误自动恢复 |
| `hashline-read-enhancer` | Hashline 读取增强 |
| `hashline-edit-diff-enhancer` | Hashline 编辑 diff 增强 |
| `fsync-skip-warning` | 跳过 fsync 时警告 |
| `tool-output-truncator` | 工具输出智能截断 |
| `json-error-recovery` | JSON 解析错误恢复 |

#### Session 管理

| Hook | 描述 |
|------|------|
| `session-recovery` | 会话错误恢复（22+ 文件，含 thinking block 修改恢复、中断恢复） |
| `session-notification` | 会话事件通知 |
| `session-notification-sender` | 通知发送器 |
| `session-todo-status` | 会话 TODO 状态跟踪 |
| `compaction-context-injector` | 压缩时注入上下文 |
| `compaction-todo-preserver` | 压缩时保留 TODO |
| `preemptive-compaction` | 抢占式压缩（在超限前主动压缩） |
| `preemptive-compaction-trigger` | 抢占式压缩触发器 |
| `preemptive-compaction-degradation-monitor` | 压缩退化监控 |
| `anthropic-context-window-limit-recovery` | Anthropic 上下文超限恢复（激进截断 + 摘要重试） |
| `directory-agents-injector` | 注入目录级 agent 配置 |
| `directory-readme-injector` | 注入目录 README |
| `rules-injector` | 注入规则文件 |
| `compaction-model-resolver` | 压缩模型解析 |

#### Transform

| Hook | 描述 |
|------|------|
| `team-mailbox-injector` | 注入团队邮箱 |
| `team-mode-status-injector` | 注入团队模式状态 |
| `keyword-detector` | 检测消息中的关键词 |
| `think-mode` | 思考模式检测和切换 |
| `question-label-truncator` | 问题标签截断 |
| `read-image-resizer` | 读取图片自动缩放 |
| `start-work` | 工作启动上下文构建 |
| `category-skill-reminder` | 类别技能提醒 |
| `plan-format-validator` | 计划格式验证 |

#### Model / Provider

| Hook | 描述 |
|------|------|
| `model-fallback` | 模型失败自动切换 |
| `runtime-fallback` | 运行时回退（含配额错误分类、自动重试、子 agent 配额中止） |
| `anthropic-effort` | Anthropic effort 参数调整 |
| `no-hephaestus-non-gpt` | 非 GPT 模型禁用 Hephaestus agent |
| `no-sisyphus-gpt` | GPT 模型禁用 Sisyphus agent |

#### Agent / Task

| Hook | 描述 |
|------|------|
| `atlas` | Atlas agent 系统提醒模板（14KB after_execute + 7KB before_execute） |
| `ralph-loop` | Ralph 循环处理（循环状态控制、迭代继续、验证失败处理） |
| `unstable-agent-babysitter` | 不稳定 agent 监护 |
| `delegate-task-retry` | 委托任务重试 |
| `todo-continuation-enforcer` | TODO 继续执行强制器 |
| `stop-continuation-guard` | 停止继续保护 |
| `task-reminder` | 任务提醒 |
| `task-resume-info` | 任务恢复信息 |
| `tasks-todowrite-disabler` | 任务 TODO 写入禁用器 |
| `empty-task-response-detector` | 空任务响应检测 |

#### Team Mode

| Hook | 描述 |
|------|------|
| `team-session-events` | 团队会话事件（idle wake hint、error handler、leader orphan handler、member status） |
| `team-tool-gating` | 团队模式工具门控 |

#### Disposable

| Hook | 描述 |
|------|------|
| `claude-code-hooks` | Claude Code 兼容 hooks（stop、user-prompt-submit、post-tool-use、pre-compact） |
| `comment-checker` | 代码注释检查器 |
| `auto-slash-command` | 自动斜杠命令检测和执行 |
| `auto-update-checker` | 自动更新检查 |
| `background-notification` | 后台通知 |
| `legacy-plugin-toast` | 旧插件迁移提示 |
| `prometheus-md-only` | Prometheus 仅 Markdown 模式 |
| `thinking-block-validator` | Thinking block 验证 |
| `sisyphus-junior-notepad` | Sisyphus Junior Notepad |

#### Interactive Bash

| Hook | 描述 |
|------|------|
| `interactive-bash-session` | 交互式 bash 会话跟踪（状态管理、tmux 命令解析、存储） |

### 2.6 扩展 API（ExtensionContext）

参考 oh-my-pi 的扩展类型（48KB API surface）：

```typescript
type ExtensionContext = {
  // 工具注册
  registerTool: (tool: ToolDef) => void
  registerSlashCommand: (cmd: SlashCommand) => void

  // Provider 注册
  registerProvider: (provider: ProviderConfig) => void

  // 事件订阅（完整事件映射）
  on: <K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>) => void

  // 配置
  getConfig: () => Config
  getPluginConfig: (pluginName: string) => unknown

  // 系统访问
  getSystemPrompt: () => string
  setSystemPromptExtension: (ext: string) => void

  // 模型访问
  getAvailableModels: () => Model[]
  getCurrentModel: () => Model
  switchModel: (model: string) => void

  // Session 访问
  getCurrentSession: () => Session
  getSessionHistory: () => Message[]

  // UI 原语（桌面端）
  showNotification: (message: string, type: 'info' | 'warn' | 'error') => void
  showProgress: (message: string, progress: number) => void

  // 日志
  getLogger: (name: string) => Logger

  // 生命周期
  onDispose: (handler: () => void | Promise<void>) => void
}
```

### 2.6 插件加载

```typescript
// 插件发现
export function discoverPlugins(): Promise<Plugin[]> {
  const plugins: Plugin[] = []

  // 1. 全局插件目录 ~/.c0de/plugins/
  // 2. 项目插件目录 .c0de/plugins/
  // 3. npm 包（c0de-plugin-* 命名约定）

  return plugins
}

// 插件加载
export async function loadPlugin(plugin: Plugin): Promise<void> {
  // 1. 验证 manifest
  // 2. 检查依赖
  // 3. 加载 hooks
  // 4. 加载 extensions
  // 5. 注册 tools
}

// 插件激活
export async function activatePlugin(plugin: Plugin, ctx: ExtensionContext): Promise<void> {
  // 1. 调用 extension.setup(ctx)
  // 2. 注册 hook event handlers
  // 3. 标记为 active
}

// 插件停用
export async function deactivatePlugin(plugin: Plugin): Promise<void> {
  // 1. 调用 extension.dispose()
  // 2. 移除 hook handlers
  // 3. 标记为 inactive
}
```

### 2.7 依赖检查

```typescript
type DependencyCheckResult = {
  satisfied: boolean
  missing: { name: string; reason: string }[]
}

export function checkDependencies(plugin: Plugin): DependencyCheckResult {
  const missing: { name: string; reason: string }[] = []

  // 检查 Node.js 版本
  // 检查 npm 包依赖
  // 检查外部工具（如 ast-grep、chromium）
  // 检查 API key 配置

  return { satisfied: missing.length === 0, missing }
}
```
