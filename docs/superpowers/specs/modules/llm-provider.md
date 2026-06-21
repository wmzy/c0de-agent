# LLM Provider 详细设计

> 基于 pi、oh-my-pi、opencode 的 provider 实现分析。

## 1. 参考项目分析

### 1.1 Pi（@pi/ai）

**架构**：自建 provider 层，每个 provider 独立实现 SSE 解析和协议转换。

**Provider 接口**：
- 每个 provider 是一个工厂函数，接收配置返回 provider 实例
- 统一的 `ChatRequest` → `AsyncGenerator<StreamChunk>` 接口
- 内置 `event-stream.ts` 工具处理 SSE 解析

**Anthropic Provider 特性**：
- 支持 extended thinking（thinking blocks 流式输出）
- `cache_control` 缓存断点：在 system prompt 末尾和工具定义后插入 `{ type: 'ephemeral' }`
- 消息转换：将内部消息格式转为 Anthropic Messages API 格式
- 处理 `content_block_start` / `content_block_delta` / `content_block_stop` 事件

**OpenAI Responses Provider 特性**：
- 支持 Responses API（新一代）和 Chat Completions API（兼容层）
- `openai-responses-shared.ts`（19KB）共享逻辑
- `openai-prompt-cache.ts` 处理缓存优化
- 工具调用：`function_call` / `tool_calls` 格式自动适配

**Token 计数**：
- `models.generated.ts`（445KB）预生成的模型能力数据库
- 每个模型的 context window、max output、cost per token

**关键设计**：
- Provider 和 Protocol 分离：Provider 管理认证和配置，Protocol 处理具体 API 格式
- `transform-messages.ts` 负责消息格式转换
- `simple-options.ts` 简化常用配置

### 1.2 OpenCode（@opencode/llm）

**架构**：三层分离——Provider → Route → Protocol。

**Provider 层**（`providers/`）：
- 轻量适配器，每个 provider 只定义 base URL 和 SDK 选择
- `openai.ts`：2.5KB，定义 OpenAI SDK 配置
- `anthropic.ts`：1.2KB，定义 Anthropic SDK 配置

**Route 层**（`route/`）：
- `client.ts`（16KB）：统一的 HTTP 客户端，处理认证、重试、超时
- `protocol.ts`：协议选择逻辑
- `framing.ts`：SSE 帧解析
- `transport/http.ts`：HTTP 传输层，支持流式和非流式

**Protocol 层**（`protocols/`）：
- `openai-chat.ts`（19KB）：OpenAI Chat Completions 协议实现
- `anthropic-messages.ts`（32KB）：Anthropic Messages 协议实现
- `shared.ts`（14KB）：共享的流处理逻辑
- `utils/tool-stream.ts`（22KB）：工具调用流式解析
- `utils/lifecycle.ts`：请求生命周期管理
- `utils/cache.ts`：缓存策略

**Schema 层**（`schema/`）：
- `messages.ts`（16KB）：消息类型定义（含工具调用、thinking blocks）
- `events.ts`（15KB）：事件类型定义
- `errors.ts`（6KB）：错误类型（TaggedError 模式）
- `options.ts`（8KB）：请求选项

**错误处理**：
- `provider-error.ts`：Provider 错误类型（429 限流、5xx 服务端、认证失败）
- 每种错误类型对应不同的重试策略

### 1.3 Oh-My-Pi（config/settings）

**Provider 路由**：
- 40+ provider 支持
- 角色路由：`default` / `smol` / `slow` / `plan` / `commit`
- 路径作用域模型覆盖（不同目录可用不同模型）
- Round-robin 凭证轮换（多个 API key 负载均衡）
- Fallback 链：主 provider 失败自动切换备用

**配置结构**：
```yaml
providers:
  openai:
    apiKey: sk-xxx
    models:
      gpt-4.1: { contextWindow: 1048576 }
  anthropic:
    apiKey: sk-ant-xxx
roleRouting:
  default: { provider: openai, model: gpt-4.1 }
  smol: { provider: openai, model: gpt-4.1-mini }
  slow: { provider: anthropic, model: claude-sonnet-4 }
```

---

## 2. c0de-agent LLM Provider 设计

### 2.1 架构

采用 opencode 的三层分离思路，但简化实现：

```
src/llm/
├── provider.ts          Provider 注册与管理
├── types.ts             协议级类型定义
├── stream.ts            SSE 流式解析
├── protocol/
│   ├── openai-chat.ts   OpenAI Chat Completions
│   ├── openai-responses.ts  OpenAI Responses API
│   ├── anthropic.ts     Anthropic Messages API
│   ├── google.ts        Gemini API
│   └── openai-compat.ts OpenAI 兼容适配器
├── cache.ts             缓存策略
├── token.ts             Token 计数
├── models.ts            模型能力注册表
├── routing.ts           角色路由 + fallback
└── index.ts
```

### 2.2 核心类型

```typescript
// 协议级消息（发给 LLM 的格式）
type ChatMessage =
  | { role: 'system'; content: string; cacheControl?: CacheControl }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; thinking?: string }
  | { role: 'tool'; toolCallId: string; content: string }

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; mediaType: string; data: string } }

type ToolCall = {
  id: string
  name: string
  arguments: string  // JSON string
}

type ChatTool = {
  name: string
  description: string
  parameters: JSONSchema
  cacheControl?: CacheControl
}

type ChatRequest = {
  model: string
  messages: ChatMessage[]
  tools?: ChatTool[]
  stream: true
  maxTokens?: number
  temperature?: number
  system?: string
  stopSequences?: string[]
}

// 流式响应块
type StreamChunk =
  | { _tag: 'text'; text: string }
  | { _tag: 'tool_call_start'; id: string; name: string }
  | { _tag: 'tool_call_delta'; id: string; argumentsDelta: string }
  | { _tag: 'tool_call_end'; id: string }
  | { _tag: 'thinking'; text: string }
  | { _tag: 'usage'; inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }
  | { _tag: 'error'; error: ProviderError }
  | { _tag: 'done' }

// Provider 错误
type ProviderError =
  | { _tag: 'rate_limit'; retryAfter?: number }
  | { _tag: 'auth_error'; message: string }
  | { _tag: 'server_error'; status: number; message: string }
  | { _tag: 'timeout' }
  | { _tag: 'network_error'; message: string }
  | { _tag: 'model_not_found'; model: string }
```

### 2.3 Protocol 接口

```typescript
type ProtocolHandler = {
  name: string

  // 发起流式请求
  chat(request: ChatRequest, config: ProviderConfig): AsyncGenerator<StreamChunk>

  // 可选：列出可用模型
  listModels?(config: ProviderConfig): Promise<Model[]>

  // 可选：应用缓存优化
  applyCache?(request: ChatRequest): ChatRequest
}
```

### 2.4 SSE 流式解析

```typescript
// 通用 SSE 解析器
type SSEEvent = {
  event?: string
  data: string
}

export function parseSSEStream(response: Response): AsyncGenerator<SSEEvent>
```

每个 protocol 实现自己的事件到 StreamChunk 的转换：

**OpenAI Chat Completions**：
```
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\"pa"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"src/\"}}]}}]}
data: [DONE]
```

**Anthropic Messages**：
```
event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":100}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"read"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}
```

**Google Gemini**：
```
data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"usageMetadata":{"promptTokenCount":100}}]}
```

### 2.5 缓存优化

```typescript
type CacheControl = { type: 'ephemeral' }

// Anthropic：显式缓存断点
function applyAnthropicCache(request: ChatRequest): ChatRequest {
  // 在 system prompt 末尾添加 cache_control
  // 在最后一个工具定义添加 cache_control
}

// DeepSeek/OpenAI：自动前缀缓存
// 优化策略：保持 system prompt + tools 稳定，消息追加到尾部
function applyAutoPrefixCache(request: ChatRequest): ChatRequest {
  // 确保 system prompt 不含时间戳等变量
  // 确保工具定义顺序稳定
}

// Google：Context Caching API
function applyGoogleCache(request: ChatRequest, config: ProviderConfig): ChatRequest {
  // 创建 cached content，后续请求引用 cache ID
}
```

### 2.6 Token 计数

```typescript
// 基于 tiktoken/gpt-tokenizer 的本地计数
export function estimateTokens(text: string, model: string): number

// 模型能力数据库（预生成）
type ModelInfo = {
  id: string
  contextWindow: number
  maxOutput: number
  costPer1kInput: number
  costPer1kOutput: number
  supportsTools: boolean
  supportsVision: boolean
  supportsThinking: boolean
}
```

### 2.7 角色路由 + Fallback

```typescript
type ModelRole = 'default' | 'smol' | 'slow' | 'plan' | 'commit'

type RoleRouting = Record<ModelRole, { provider: string; model: string }>

type FallbackChain = {
  primary: string
  fallbacks: string[]
  retryDelay: number
  maxRetries: number
}

// 解析角色到具体 provider + model
export function resolveModel(
  registry: ProviderRegistry,
  role: ModelRole,
  routing: RoleRouting
): { provider: string; model: string }

// 带 fallback 的流式请求
export function chatStreamWithFallback(
  registry: ProviderRegistry,
  request: ChatRequest,
  chain: FallbackChain
): AsyncGenerator<StreamChunk>
```

**Fallback 触发条件**：
- HTTP 429（限流）→ 等待 retryAfter 后重试，超过阈值切 fallback
- HTTP 5xx（服务端错误）→ 立即切 fallback
- 网络超时 → 重试一次，失败切 fallback
- API key 无效 → 立即切 fallback

---

## 3. Provider 特有实现细节

### 3.1 OpenAI

- **Chat Completions API**：`POST /v1/chat/completions`
- **Responses API**（新）：`POST /v1/responses`，支持更长上下文和更好的工具调用
- **工具调用格式**：`tool_calls[].function.{name, arguments}`
- **Thinking**：通过 `reasoning` 字段（o1/o3 模型）
- **缓存**：自动前缀缓存，无需显式控制
- **SSE 格式**：`data: {JSON}\n\n`，`data: [DONE]` 结束

### 3.2 Anthropic

- **Messages API**：`POST /v1/messages`
- **工具调用格式**：`content[].type === 'tool_use'`
- **Thinking**：`content[].type === 'thinking'`（extended thinking）
- **缓存**：显式 `cache_control: { type: 'ephemeral' }` 断点
- **SSE 格式**：`event: {type}\ndata: {JSON}\n\n`
- **特殊**：需要 `anthropic-version` header，beta features 通过 `anthropic-beta` header

### 3.3 Google Gemini

- **GenerateContent API**：`POST /v1/models/{model}:streamGenerateContent`
- **工具调用格式**：`functionCall.{name, args}`
- **Thinking**：`thought: true` 标记
- **缓存**：Context Caching API（`cachedContents`）
- **SSE 格式**：JSON 数组流式返回
- **特殊**：SSE 返回的是 JSON 对象，不是标准 SSE 格式

### 3.4 DeepSeek

- **OpenAI 兼容**：`POST /v1/chat/completions`
- **工具调用格式**：同 OpenAI
- **Thinking**：`reasoning_content` 字段
- **缓存**：自动前缀缓存
- **特殊**：`deepseek-reasoner` 模型的 thinking 格式与 OpenAI 不同

### 3.5 OpenAI 兼容适配器

覆盖大多数第三方 provider（Groq、Together、Fireworks、Mistral 等）：
- 统一使用 OpenAI Chat Completions 格式
- 差异通过 profile 配置处理（如不同 provider 的 tool_choice 支持程度）
- 自动检测 provider 能力（通过 `/v1/models` 接口）
