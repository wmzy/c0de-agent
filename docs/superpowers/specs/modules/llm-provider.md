# LLM Provider 详细设计

> 基于 opencode (`@opencode/llm`) 的 provider / route / protocol 三层实现分析，并完整保留其错误分类、事件协议、协议路由管线、工具流累加、内容块生命周期、缓存断点、重试策略与上下文溢出检测。

## 1. 总体架构

### 1.1 三层分离

opencode LLM 包采用清晰的“协议 → 路由 → 传输”三层职责切分。所有 provider 都由相同的四个轴组合而成（**Protocol + Endpoint + Auth + Framing**），加可选的 `Transport`、`Headers`、`Defaults`。这使得 DeepSeek / TogetherAI / Cerebras / Groq 等多家共享 `OpenAIChat.protocol` 而无需在每个 provider 复制 300 行实现。

```mermaid
flowchart LR
  App[Agent Loop / Processor] --> Req[LLMRequest]
  Req --> Comp[compile<br/>applyCachePolicy + body.from + validate + prepare]
  Comp --> Route[Route<br/>provider / protocol / endpoint / auth / framing / defaults]
  Route -->|frames| T[Transport.httpJson<br/>URL + Headers + JSON body]
  T --> Net[HTTP/JSON Request]
  Net -->|bytes stream| F[Framing.sse<br/>UTF-8 decode → SSE channel]
  F -->|frame| Dec[protocol.stream.event schema]
  Dec --> Step[protocol.stream.step<br/>State → LLMEvent[]]
  Step --> Out[AsyncGenerator<LLMEvent>]
```

四轴含义：

- **Protocol**：某模型服务族（OpenAI Chat / OpenAI Responses / Anthropic Messages / Gemini / Bedrock Converse）的“语义 API 合约”：如何把通用 `LLMRequest` 翻译成 provider-native body、JSON 编码前必须满足什么 schema、如何把 streaming 响应解码回通用 `LLMEvent`。
- **Endpoint**：URL 构造（baseURL + path + query），可注入模型 id 或区域。
- **Auth**：bearer / header / SDK 凭证 / config 注入。
- **Framing**：把字节流转成帧（SSE 文本帧、AWS event stream 二进制帧）。

### 1.2 文件布局

```
src/llm/
├── provider.ts                  公共 Provider 工厂接口
├── provider-error.ts            上下文溢出检测 (20+ 正则)
├── cache-policy.ts              applyCachePolicy (auto/none/object)
├── schema/
│   ├── ids.ts                   ProtocolID/RouteID/ModelID/ProviderID/...
│   ├── options.ts               HttpOptions/GenerationOptions/Model/CacheHint/CachePolicy
│   ├── messages.ts              SystemPart/ContentPart/Message/ToolDefinition/LLMRequest
│   ├── events.ts                Usage/StepStart/TextStart..End/ToolInputStart..End/...
│   │                            LLMEvent union / LLMResponse / PreparedRequest
│   └── errors.ts                HttpContext + 10 个 LLMErrorReason + LLMError + ToolFailure
├── route/
│   ├── protocol.ts              Protocol<Body, Frame, Event, State>
│   ├── endpoint.ts              baseURL + path + query (string | fn)
│   ├── auth.ts / auth-options.ts
│   ├── framing.ts               Framing<Frame> (sse / aws-event-stream)
│   ├── client.ts                Route.make / LLMClient.prepare / stream / generate
│   └── transport/
│       ├── index.ts             Transport<Body, Prepared, Frame>
│       ├── http.ts              httpJson / sseJson (POST + JSON + sse)
│       └── websocket.ts
└── protocols/
    ├── shared.ts                sseFraming / validateWith / parseToolInput / system update / ...
    ├── anthropic-messages.ts
    ├── bedrock-converse.ts
    ├── bedrock-event-stream.ts
    ├── openai-chat.ts / openai-responses.ts / openai-compatible-chat.ts
    ├── gemini.ts
    ├── index.ts
    └── utils/
        ├── tool-stream.ts       ToolStream.empty/start/appendOrStart/appendExisting/
        │                        finish/finishWithInput/finishAll
        ├── lifecycle.ts         Lifecycle.initial/stepStart/textDelta/.../finish
        ├── cache.ts             newBreakpoints(4) + ttlBucket (5m | 1h)
        ├── openai-options.ts
        ├── gemini-tool-schema.ts
        ├── bedrock-{auth,cache,media}.ts
```

---

## 2. Schema 层（`schema/`）

### 2.1 ID / 基础类型（`schema/ids.ts`）

```ts
ProtocolID        = string                              // 协议稳定 id
RouteID           = string                              // 可运行路由 id
ModelID           = string & brand "LLM.ModelID"
ProviderID        = string & brand "LLM.ProviderID"
ResponseID        = string
ContentBlockID    = string                              // 文本/推理 block id
ToolCallID        = string                              // 工具调用 id

ReasoningEffort   = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
TextVerbosity     = "low" | "medium" | "high"
MessageRole       = "system" | "user" | "assistant" | "tool"
FinishReason      = "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown"
JsonSchema        = Record<string, unknown>
ProviderMetadata  = Record<provider, Record<string, unknown>>   // 透传 provider 原始 payload
```

### 2.2 选项（`schema/options.ts`）

```ts
class HttpOptions {
  body?:     JsonSchema                                 // 顶层 body overlay
  headers?:  Record<string, string>
  query?:    Record<string, string>
}

class GenerationOptions {
  maxTokens?:         number
  temperature?:       number
  topP?:              number
  topK?:              number
  frequencyPenalty?:  number
  presencePenalty?:   number
  seed?:              number
  stop?:              string[]
}

class ModelLimits {
  context?: number                                      // context window
  output?:  number                                      // 单次输出上限
}

class Model {                                            // 不可变：id + provider + route
  constructor({ id: ModelID, provider: ProviderID, route: AnyRoute })
  static make / static input / static update
}

class CacheHint {
  type:        "ephemeral" | "persistent"
  ttlSeconds?: number                                    // 影响 cache.ts ttlBucket
}

CachePolicyObject = {
  tools?:     boolean
  system?:    boolean
  messages?:  "latest-user-message" | "latest-assistant" | { tail: number }
  ttlSeconds?: number
}
CachePolicy = "auto" | "none" | CachePolicyObject

ProviderOptions = Record<provider, Record<string, unknown>>
```

`mergeHttpOptions`、`mergeProviderOptions`、`mergeGenerationOptions` 均为深度合并；同名字段以后者（route defaults + request + patch）覆盖，HTTP header 后写者覆盖前写者。

### 2.3 消息（`schema/messages.ts`）

```ts
class SystemPart {                                       // 单段系统提示
  type: "text"
  text: string
  cache?: CacheHint
  metadata?: Record<string, unknown>
}

class TextPart {
  type: "text"
  text: string
  cache?: CacheHint
  metadata?: Record<string, unknown>
  providerMetadata?: ProviderMetadata
}

class MediaPart {                                        // 用户侧附件
  type: "media"
  mediaType: string                                      // "image/png" 等
  data:    string | Uint8Array
  filename?: string
  metadata?: Record<string, unknown>
}

class ToolResultMediaPart {                              // tool-result 内嵌媒体
  type: "media"
  mediaType: string
  data: string                                           // base64
  filename?: string
  metadata?: Record<string, unknown>
}

ToolResultContentPart = TextPart | ToolResultMediaPart

class ToolTextContent { type: "text", text: string }
ToolFileSource        = {type:"data",data} | {type:"url",url} | {type:"file",uri}
class ToolFileContent  { type:"file", source:ToolFileSource, mime:string, name?:string }
ToolContent           = ToolTextContent | ToolFileContent

ToolResultValue =
  | { type: "json",     value: unknown }
  | { type: "text",     value: unknown }
  | { type: "error",    value: unknown }
  | { type: "content",  value: ToolResultContentPart[] }

interface ToolOutput {                                   // handler 返回
  structured: unknown                                    // 机器可读主体
  content:    ReadonlyArray<ToolContent>                 // UI 友好主体
}

class ToolCallPart {
  type: "tool-call"
  id: string
  name: string
  input: unknown                                         // 已 parse
  providerExecuted?: boolean
  metadata?: Record<string, unknown>
  providerMetadata?: ProviderMetadata
}

class ToolResultPart {
  type: "tool-result"
  id: string
  name: string
  result: ToolResultValue
  providerExecuted?: boolean
  cache?: CacheHint
  metadata?: Record<string, unknown>
  providerMetadata?: ProviderMetadata
}

class ReasoningPart {                                    // thinking block
  type: "reasoning"
  text: string
  encrypted?: string                                     // Anthropic 加密 thinking
  metadata?: Record<string, unknown>
  providerMetadata?: ProviderMetadata
}

ContentPart = TextPart | MediaPart | ToolCallPart | ToolResultPart | ReasoningPart

class Message {
  id?:       string
  role:      MessageRole
  content:   ContentPart[]                               // 永远数组（输入字符串归一化）
  metadata?: Record<string, unknown>
  native?:   Record<string, unknown>                     // 已下发的 provider-native 字段
}
Message.user/assistant/system/tool                       // ergonomic 构造

class ToolDefinition {
  name:         string
  description:  string
  inputSchema:  JsonSchema
  outputSchema?: JsonSchema
  cache?:       CacheHint
  metadata?:    Record<string, unknown>
  native?:      Record<string, unknown>                  // 透传 provider 私有字段
}

class ToolChoice {
  type: "auto" | "none" | "required" | "tool"
  name?: string                                          // type === "tool" 时必填
}

ResponseFormat =
  | { type: "text" }
  | { type: "json", schema: JsonSchema }
  | { type: "tool", tool: ToolDefinition }

class LLMRequest {
  id?:               string
  model:             Model                               // 必填
  system:            SystemPart[]                        // 永远数组
  messages:          Message[]
  tools:             ToolDefinition[]
  toolChoice?:       ToolChoice
  generation?:       GenerationOptions
  providerOptions?:  ProviderOptions
  http?:             HttpOptions
  responseFormat?:   ResponseFormat
  cache?:            CachePolicy                         // "auto" | "none" | 对象
  metadata?:         Record<string, unknown>
}
LLMRequest.update(request, patch)                        // 不可变 patch
```

### 2.4 事件（`schema/events.ts`）

所有事件通过 `Schema.toTaggedUnion("type")` 统一为 `LLMEvent` tagged union，并暴露 camelCase 守卫（`LLMEvent.is.textDelta` 等）与构造器（`LLMEvent.textDelta({...})`，自动把字符串 id 包装为 `ContentBlockID`/`ToolCallID`）。

#### 2.4.1 `Usage`（`LLM.Usage`）

```ts
class Usage {
  inputTokens?:           number                         // inclusive（含 cache + reasoning）
  outputTokens?:          number                         // inclusive（含 reasoning）
  nonCachedInputTokens?:  number                         // 干净 prompt
  cacheReadInputTokens?:  number                         // 命中缓存
  cacheWriteInputTokens?: number                         // 写入缓存
  reasoningTokens?:       number                         // 输出中 reasoning 子集
  totalTokens?:           number                         // provider 报告值 → fallback input+output
  providerMetadata?:      ProviderMetadata               // { openai: {...} } 原始负载
  get visibleOutputTokens(): number                      // max(0, output - reasoning)
  static from(UsageInput)
}
```

不变式：`nonCachedInput + cacheRead + cacheWrite === input`，`reasoning ≤ output`。每个字段都独立存储，下游消费时不需要做减法，避免 `clamp` 后被错误覆盖。

#### 2.4.2 事件类型

| 事件 | 字段 | 用途 |
| --- | --- | --- |
| `StepStart` | `type, index: number` | 每个 step 起始一次（agent loop 多步） |
| `TextStart` | `type, id: ContentBlockID, providerMetadata?` | 文本 block 开始 |
| `TextDelta` | `type, id, text: string, providerMetadata?` | 文本增量 |
| `TextEnd` | `type, id, providerMetadata?` | 文本 block 结束 |
| `ReasoningStart` | `type, id, providerMetadata?` | reasoning block 开始 |
| `ReasoningDelta` | `type, id, text, providerMetadata?` | reasoning 增量 |
| `ReasoningEnd` | `type, id, providerMetadata?` | reasoning block 结束 |
| `ToolInputStart` | `type, id: ToolCallID, name, providerMetadata?` | 工具调用开始（含 id/name） |
| `ToolInputDelta` | `type, id, name, text` | 工具参数 JSON 增量 |
| `ToolInputEnd` | `type, id, name, providerMetadata?` | 工具调用参数结束 |
| `ToolCall` | `type, id, name, input (parsed), providerExecuted?, providerMetadata?` | 完成、已解析的工具调用 |
| `ToolResult` | `type, id, name, result: ToolResultValue, output?: ToolOutput, providerExecuted?, providerMetadata?` | 客户端执行结果回灌 |
| `ToolError` | `type, id, name, message, error?: Defect, providerMetadata?` | handler 抛 ToolFailure |
| `StepFinish` | `type, index, reason: FinishReason, usage?, providerMetadata?` | 单步完成 |
| `Finish` | `type, reason, usage?, providerMetadata?` | 整个流结束 |
| `ProviderErrorEvent` | `type, message, classification?: "context-overflow", retryable?: boolean, providerMetadata?` | provider 失败（不一定 throw） |

`LLMEvent = Schema.Union([StepStart, TextStart, TextDelta, TextEnd, ReasoningStart, ReasoningDelta, ReasoningEnd, ToolInputStart, ToolInputDelta, ToolInputEnd, ToolCall, ToolResult, ToolError, StepFinish, Finish, ProviderErrorEvent])`，全部带 `providerMetadata?` 以透传 raw 负载。

#### 2.4.3 `PreparedRequest` / `LLMResponse`

```ts
class PreparedRequest {                                  // LLMClient.prepare 输出
  id: string
  route: RouteID
  protocol: ProtocolID
  model: Model
  body: unknown                                          // 已通过 protocol.body.schema
  metadata?: Record<string, unknown>                     // { transport: ... }
}
type PreparedRequestOf<Body> = Omit<PreparedRequest, "body"> & { body: Body }

class LLMResponse {                                      // LLMClient.generate 输出
  events: LLMEvent[]
  usage?: Usage
  get text():        string                              // 拼接 textDelta.text
  get reasoning():   string                              // 拼接 reasoningDelta.text
  get toolCalls():   ToolCall[]                          // events.filter(is.toolCall)
}
LLMResponse.text/reasoning/toolCalls/usage(responselike)  // 兼容 events 或 LLMResponse
```

### 2.5 错误分类（`schema/errors.ts`）

#### 2.5.1 共享 `HttpContext`

```ts
class HttpRequestDetails {
  method:  string
  url:     string
  headers: Record<string, string>
}
class HttpResponseDetails {
  status:  number
  headers: Record<string, string>
}
class HttpRateLimitDetails {
  retryAfterMs?: number
  limit?:        Record<string, string>                  // header 原值
  remaining?:    Record<string, string>
  reset?:        Record<string, string>
}
class HttpContext {
  request:       HttpRequestDetails
  response?:     HttpResponseDetails
  body?:         string
  bodyTruncated?: boolean
  requestId?:    string
  rateLimit?:    HttpRateLimitDetails
}

type ProviderFailureClassification = "context-overflow"
```

#### 2.5.2 `LLMErrorReason`（10 个 tagged union）

每个 reason 都带 `_tag`（用于 `Schema.toTaggedUnion`）以及 `retryable: boolean` getter。

| `_tag` | 关键字段 | retryable | 触发条件 |
| --- | --- | --- | --- |
| `InvalidRequest` | `message, parameter?, classification?: "context-overflow", providerMetadata?, http?` | `false` | 用户请求 schema 不合法 / 上下文溢出（当 `classification === "context-overflow"`） |
| `NoRoute` | `route: RouteID, provider: ProviderID, model: ModelID` | `false` | 给定 provider/model 找不到 route（message 自动 = `No LLM route for ... using ...`） |
| `Authentication` | `message, kind: "missing"\|"invalid"\|"expired"\|"insufficient-permissions"\|"unknown", providerMetadata?, http?` | `false` | 401/403 / 凭证过期 |
| `RateLimit` | `message, retryAfterMs?, rateLimit?, providerMetadata?, http?` | **`true`** | 429 / 限流（带 retry-after） |
| `QuotaExceeded` | `message, providerMetadata?, http?` | `false` | 配额耗尽（区别于 rate limit，不可重试） |
| `ContentPolicy` | `message, providerMetadata?, http?` | `false` | 内容被 provider 安全策略拦截 |
| `ProviderInternal` | `message, status: number, retryAfterMs?, providerMetadata?, http?` | **`true`** | 5xx / Overloaded |
| `Transport` | `message, kind?, url?, http?` | `false` | TCP/TLS 失败 / 超时 / 序列化错 |
| `InvalidProviderOutput` | `message, route?, raw?, providerMetadata?` | `false` | SSE 帧无法解析 / 字段缺失 |
| `UnknownProvider` | `message, status?, providerMetadata?, http?` | `false` | 未分类的 provider 异常 |

```ts
LLMErrorReason = Schema.Union([
  InvalidRequestReason, NoRouteReason, AuthenticationReason,
  RateLimitReason, QuotaExceededReason, ContentPolicyReason,
  ProviderInternalReason, TransportReason, InvalidProviderOutputReason,
  UnknownProviderReason,
]).pipe(Schema.toTaggedUnion("_tag"))
```

#### 2.5.3 `LLMError` 与 `ToolFailure`

```ts
class LLMError extends TaggedErrorClass("LLM.Error", {
  module:  string                                        // 错误来源模块
  method:  string                                        // 哪个方法抛
  reason:  LLMErrorReason
}) {
  override readonly cause = this.reason
  get retryable()                                         // delegate to reason
  get retryAfterMs()                                      // RateLimit/ProviderInternal 的字段
  override get message(): `${module}.${method}: ${reason.message}`
}

class ToolFailure extends TaggedErrorClass("LLM.ToolFailure", {
  message:  string
  error?:   Defect                                        // 原始 cause
  metadata?: Record<string, unknown>
})
```

`ToolFailure` 是 tool execute handler 的失败契约：handler 必须把内部错误映射为 `ToolFailure`；runtime 捕获后会产出 `tool-error` 事件 + `type: "error"` 的 `tool-result`，让模型自纠正。任何非 `ToolFailure` 的抛出/产出都被视为缺陷并中断流。

---

## 3. Route 管线（Protocol → Endpoint → Auth → Framing → Transport → Client）

### 3.1 `Protocol`（`route/protocol.ts`）

```ts
interface Protocol<Body, Frame, Event, State> {
  readonly id: ProtocolID
  readonly body: ProtocolBody<Body>
  readonly stream: ProtocolStream<Frame, Event, State>
}
interface ProtocolBody<Body> {
  readonly schema: Schema.Codec<Body, unknown>            // 校验并编码 JSON body
  readonly from:   (request: LLMRequest) => Effect.Effect<Body, LLMError>
}
interface ProtocolStream<Frame, Event, State> {
  readonly event:   Schema.Codec<Event, Frame>            // 把一帧解为类型化事件
  readonly initial: (request: LLMRequest) => State
  readonly step:    (state: State, event: Event)
                       => Effect.Effect<[State, LLMEvent[]], LLMError>
  readonly terminal?: (event: Event) => boolean           // 取流终止条件
  readonly onHalt?:   (state: State) => LLMEvent[]       // 流被截断时强制 flush
}
const Protocol.make = (input) => input                   // identity constructor
const jsonEvent = <S>(schema: S) => Schema.fromJsonString(schema)   // SSE JSON payload schema
```

四元类型参数一一对应管线：`Body`（请求体）→ `Frame`（帧）→ `Event`（类型化事件）→ `State`（流式累加器状态）。

**示例**（OpenAI Chat / Anthropic Messages / Bedrock Converse 都符合同一形态）：

- `OpenAIChat.protocol`     — chat completions
- `OpenAIResponses.protocol`— responses API
- `AnthropicMessages.protocol` — content blocks with thinking
- `Gemini.protocol`         — generateContent
- `BedrockConverse.protocol`— Converse + binary event-stream framing

### 3.2 `Endpoint`（`route/endpoint.ts`）

```ts
interface EndpointInput<Body>  { request: LLMRequest, body: Body }
type     EndpointPart<Body>    = string | ((input: EndpointInput<Body>) => string)

interface Endpoint<Body> {
  baseURL?: string
  path:     EndpointPart<Body>                            // 动态：Bedrock/Gemini 嵌 model id
  query?:   Record<string, string>
}
const path   = (value, options?) => ({ ...options, path: value })
const merge  = (base, patch)    => Endpoint
const render = (endpoint, input) => URL                     // trim trailing /, merge query
```

### 3.3 `Framing`（`route/framing.ts`）

```ts
interface Framing<Frame> {
  readonly id: string
  readonly frame: (bytes: Stream<Uint8Array, LLMError>) => Stream<Frame, LLMError>
}
const sse: Framing<string> = { id: "sse", frame: ProviderShared.sseFraming }
```

`Framing` 是字节流 → 帧的桥。SSE 实现复用 `effect/unstable/encoding/Sse`：

```ts
export const sseFraming = (bytes: Stream<Uint8Array, LLMError>): Stream<string, LLMError> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.catchTag("Retry", () => Stream.empty),         // 忽略 Retry 控制事件
    Stream.filter((event) => event.data.length > 0 && event.data !== "[DONE]"),
    Stream.map((event) => event.data),                     // 每帧 = data 字段的 JSON 字符串
  )
```

AWS event stream（Bedrock）是另一个 `Framing<Frame>` 实现：length-prefixed 二进制帧 + CRC，输出 `Frame = 已解析的二进制记录`。

### 3.4 `Transport` / `httpJson` / `sseJson`（`route/transport/http.ts`）

```ts
export type JsonRequestInput<Body> = TransportPrepareInput<Body>
export interface JsonRequestParts<Body = unknown> {
  url:      string
  jsonBody: Body | Record<string, unknown>
  bodyText: string                                        // 已编码 body
  headers:  Headers.Headers
}
export interface HttpPrepared<Frame> {
  request: HttpClientRequest.HttpClientRequest            // Effect HttpClient
  framing: Framing<Frame>
}

const httpJson = <Body, Frame>(input: HttpJsonInput<Body, Frame>): HttpJsonTransport<Body, Frame> => ({
  id: "http-json",
  with: (patch) => httpJson({ ...input, ...patch }),
  prepare: (input) => Effect.gen(function* () {
    // 1) 应用 endpoint.query
    // 2) 应用 request.http.body overlay（仅当 body 是 JSON object 时）
    // 3) Auth.toEffect(auth)({ request, method:"POST", url, body, headers })
    // 4) 返回 { request: jsonPost(url, bodyText, headers), framing }
  }),
  frames: (prepared, request, runtime) =>
    Stream.unwrap(runtime.http.execute(prepared.request).pipe(
      Effect.map((response) => prepared.framing.frame(
        response.stream.pipe(Stream.mapError(err => eventError(route, "Failed to read ... stream", errorText(err))))
      )),
    )),
})

export const sseJson = {
  id: "http-json/sse",
  with: <Body>() => httpJson<Body, string>({ framing: Framing.sse }),
} as const
```

要点：

- 头部合并顺序：调用者静态 header → `Auth` 注入 → `http.headers` overlay。
- `request.http.body` 与 provider-native body 做浅合并（`mergeJsonRecords`）；非对象 body 直接报错为 `InvalidRequest`。
- `frames` 阶段把字节流错误统一包成 `LLMError(module="ProviderShared", reason=InvalidProviderOutput)`。

### 3.5 `Route.make` / `LLMClient`（`route/client.ts`）

```ts
interface Route<Body, Prepared = unknown> {
  readonly id:        string                              // 路由 id
  readonly provider?: ProviderID
  readonly protocol:  ProtocolID
  readonly endpoint:  Endpoint<Body>
  readonly auth:      Auth
  readonly transport: Transport<Body, Prepared, unknown>
  readonly defaults:  RouteDefaults
  readonly body:      RouteBody<Body>                     // { schema, from }
  readonly with:       (patch: RoutePatch<Body, Prepared>) => Route<Body, Prepared>
  readonly model:      (input: RouteMappedModelInput) => Model
  readonly prepareTransport: (body, request) => Effect<Prepared, LLMError>
  readonly streamPrepared:  (prepared, request, runtime) => Stream<LLMEvent, LLMError>
}

interface RouteBody<Body> {
  schema: Schema.Codec<Body, unknown>
  from:   (request: LLMRequest) => Effect<Body, LLMError>
}

interface RouteDefaults {
  headers?:        Record<string, string>
  limits?:         ModelLimits
  generation?:     GenerationOptions
  providerOptions?: ProviderOptions
  http?:           HttpOptions
}
interface RouteDefaultsInput { /* 同上但用 .Input 版本，便于构造 */ }
interface RoutePatch<Body, Prepared> extends RouteDefaultsInput {
  id?:       string
  provider?: string | ProviderID
  auth?:     AuthDef
  transport?: Transport<Body, Prepared, unknown>
  endpoint?: EndpointPatch<Body>
}

interface StreamMethod { (request: LLMRequest): Stream<LLMEvent, LLMError> }
interface GenerateMethod { (request: LLMRequest): Effect<LLMResponse, LLMError> }
interface Interface {
  prepare: <Body = unknown>(request: LLMRequest) => Effect<PreparedRequestOf<Body>, LLMError>
  stream:  StreamMethod
  generate: GenerateMethod
}

class Service extends Context.Service<Service, Interface>()("@opencode/LLMClient") {}

export function make<Body, Frame, Event, State>(input: MakeInput<...>): Route<Body, HttpPrepared<Frame>>
export function make<Body, Prepared, Frame, Event, State>(input: MakeTransportInput<...>): Route<Body, Prepared>
```

`Route.make` 内部：

```ts
const protocol = input.protocol
const encodeBody      = Schema.encodeSync(Schema.fromJsonString(protocol.body.schema))
const decodeEventEffect = Schema.decodeUnknownEffect(protocol.stream.event)
const decodeEvent = (route) => (frame) =>
  decodeEventEffect(frame).pipe(Effect.mapError(() =>
    eventError(route, `Invalid ${route} stream event`, typeof frame === "string" ? frame : encodeJson(frame))
  ))

build(...) => Route({
  ...
  with: patch => build({ ...routeInput, ...patch, defaults: mergeRouteDefaults(...) }),
  prepareTransport: (body, request) => transport.prepare({ body, request, endpoint, auth, encodeBody, headers }),
  streamPrepared: (prepared, request, runtime) => {
    const events = transport.frames(prepared, request, runtime)
      .pipe(Stream.mapEffect(decodeEvent(route)),
            terminal ? Stream.takeUntil(terminal) : identity)
    return events.pipe(
      Stream.mapAccumEffect(
        () => protocol.stream.initial(request),
        protocol.stream.step,
        onHalt ? { onHalt: protocol.stream.onHalt } : undefined,
      ),
      Stream.catchCause(cause => Stream.fail(streamError(route, "Failed to read ... stream", cause))),
    )
  },
})
```

#### 3.5.1 `compile` 边界

```ts
const compile = Effect.fn("LLM.compile")(function* (request: LLMRequest) {
  const resolved = applyCachePolicy(resolveRequestOptions(request))    // 1) 注入缓存断点
  const route    = resolved.model.route
  const body     = yield* route.body.from(resolved)                    // 2) 通用请求 → provider body
                       .pipe(Effect.flatMap(validateWith(decodeEffect(route.body.schema))))   // 3) 校验
  const prepared = yield* route.prepareTransport(body, resolved)       // 4) transport 私有的 prepared
  return { request: resolved, route, body, prepared }
})
```

#### 3.5.2 `prepare` / `stream` / `generate`

```ts
const prepareWith = Effect.fn("LLMClient.prepare")(function* (request: LLMRequest) {
  const compiled = yield* compile(request)
  return new PreparedRequest({
    id: compiled.request.id ?? "request",
    route: compiled.route.id,
    protocol: compiled.route.protocol,
    model: compiled.request.model,
    body: compiled.body,
    metadata: { transport: compiled.route.transport.id },
  })
})

const streamRequestWith = (runtime) => (request) =>
  Stream.unwrap(Effect.gen(function* () {
    const compiled = yield* compile(request)
    return compiled.route.streamPrepared(compiled.prepared, compiled.request, runtime)
  }))

const generateWith = (stream) => Effect.fn("LLM.generate")(function* (request) {
  return new LLMResponse(yield* stream(request).pipe(Stream.runFold(
    () => ({ events: [], usage: undefined }),
    (acc, event) => {
      acc.events.push(event)
      if ("usage" in event && event.usage !== undefined) acc.usage = event.usage
      return acc
    },
  )))
})

export const prepare = <Body = unknown>(req) => prepareWith(req) as Effect<PreparedRequestOf<Body>, LLMError>
export function stream(req): Stream<LLMEvent, LLMError>     // 通过 Context.Service 解析
export function generate(req): Effect<LLMResponse, LLMError>

export const layer: Layer.Layer<Service, never, RequestExecutor.Service> = Layer.effect(Service, Effect.gen(function* () {
  const stream = streamRequestWith({
    http:     yield* RequestExecutor.Service,
    webSocket: Option.getOrUndefined(yield* Effect.serviceOption(WebSocketExecutor.Service)),
  })
  return Service.of({ prepare: prepareWith, stream, generate: generateWith(stream) })
}))

export const Route = { make } as const
export const LLMClient = { Service, layer, prepare, stream, generate } as const
```

`LLMRequest.update(request, patch)` 在 `resolveRequestOptions` 中执行：`generation = mergeGenerationOptions(route.defaults.generation, request.generation)`，HTTP / providerOptions 同理（最后写者覆盖前写者，generation 的 `latestGeneration` 取最新者）。

---

## 4. Protocol 工具集（`protocols/utils/`、`protocols/shared.ts`）

### 4.1 工具流累加器（`utils/tool-stream.ts`）

适用于所有 provider。`State<K>` 是 `Partial<Record<K, PendingTool>>`，键 K 是 provider 自己的流内标识（OpenAI Chat/Anthropic/Bedrock 用数字 index；OpenAI Responses 用字符串 `item_id`），并非最终 `ToolCallID`。

```ts
interface PendingTool extends ToolAccumulator {
  id:        string                                       // 最终 ToolCallID
  name:      string
  input:     string                                       // 累计的原始 JSON（未 parse）
  providerExecuted?:   boolean
  providerMetadata?:   ProviderMetadata
}

interface AppendOutcome<K> {
  tools:  State<K>
  tool:   PendingTool
  events: LLMEvent[]                                      // lifecycle + delta 事件
}

const empty: <K>() => State<K>
const isError = (r) => r instanceof LLMError

// start：单独 start 事件的 provider（Anthropic content_block_start / Bedrock contentBlockStart / Responses output_item.added）
const start: (tools, key, tool) => state

// appendOrStart：首帧同时携带 id/name + 文本（OpenAI Chat）
const appendOrStart: (route, tools, key, delta, missingToolMessage) => AppendOutcome | LLMError

// appendExisting：必须已有 start（保持协议在流语法层面的诚实性）
const appendExisting: (route, tools, key, text, missingToolMessage) => AppendOutcome | LLMError

// finish：单工具 finalize（缺失键为 no-op）
const finish: (route, tools, key) => Effect<{ tools, events: [toolInputEnd, toolCall] }, LLMError>

// finishWithInput：Responses 用，最终 input 字符串覆盖（避免 deltas 重复）
const finishWithInput: (route, tools, key, input) => Effect<{ tools, events: [...] }>

// finishAll：OpenAI Chat 用，没有 per-tool stop，整段结束（finish_reason）时一起 finalize
const finishAll: (route, tools) => Effect<{ tools, events: [...] }>
```

四个核心语义：

- **start** → emit `tool-input-start`，**append** → emit `tool-input-delta`（仅当 `text.length > 0`），**finish** → emit `tool-input-end` + parse JSON 后 emit `tool-call`（带 `input`）。
- `appendOrStart` 内部使用 `current?.id ?? delta.id` 与 `current?.name ?? delta.name`；缺一即返回 `eventError(route, missingToolMessage)`。
- `appendTool` 自动产出 `tool-input-start` 当对应 key 不在 state 中。
- 所有路径都通过 `parseToolInput` 把 `raw ?? "{}"` 解析成最终 `input`（空字符串视为 `{}`，用于零参工具）。
- 任何 LLM 流错误以 `LLMError(module="ProviderShared", method="stream", reason=InvalidProviderOutput)` 上抛。

### 4.2 内容块生命周期（`utils/lifecycle.ts`）

```ts
interface State {
  stepStarted: boolean
  text:       Set<ContentBlockID>
  reasoning:  Set<ContentBlockID>
}

initial: () => ({ stepStarted:false, text:new Set(), reasoning:new Set() })

stepStart(state, events):
  若 state.stepStarted 则 noop；否则 push StepStart(0) → { ...state, stepStarted:true }

textDelta(state, events, id, text):
  若 text.has(id) → push textDelta；否则 push textStart + textDelta，再把 id 加入 text
  （顺带 stepStart）

reasoningStart(state, events, id, providerMetadata?):
  若 reasoning.has(id) → noop；否则 stepStart → push reasoningStart

reasoningDelta(state, events, id, text, providerMetadata?):
  reasoningStart 后 push reasoningDelta

reasoningEnd(state, events, id, providerMetadata?):
  若 !reasoning.has(id) → noop；否则 stepStart → push reasoningEnd 并从 set 中删除

textEnd(state, events, id, providerMetadata?):
  若 !text.has(id) → noop；否则 stepStart → push textEnd 并从 set 中删除

closeOpenBlocks(state, events):
  把所有未关闭的 reasoning/text 各推一条 end 事件并清空

finish(state, events, { reason, usage?, providerMetadata? }):
  closeOpenBlocks(stepStart(...)) → push stepFinish(0, reason, usage, providerMetadata) + finish(reason, usage, providerMetadata)
  → { ...state, stepStarted:false }
```

`stepStart` 幂等：所有 delta 类函数在第一次写入前都会自动 `stepStart`，确保 `StepStart` 在每个 step 内只触发一次。

### 4.3 缓存断点（`utils/cache.ts` + `cache-policy.ts`）

#### 4.3.1 `utils/cache.ts` —— Provider 共享的 4 断点上限与 TTL 分桶

```ts
interface Breakpoints { remaining: number, dropped: number }
const newBreakpoints = (cap: number): Breakpoints        // 默认 cap = 4

// ttlSeconds >= 3600 → "1h"；否则 undefined（provider 默认 5m）
const ttlBucket = (ttlSeconds: number | undefined): "1h" | undefined
```

#### 4.3.2 `cache-policy.ts` —— `applyCachePolicy`

```ts
const AUTO: CachePolicyObject = { tools:true, system:true, messages:"latest-user-message" }
const NONE: CachePolicyObject = {}

// 解析规则：
//   undefined / "auto" → AUTO
//   "none"             → NONE
//   对象               → 原样使用

// 只对 inline hint 有意义的协议注入：
const RESPECTS_INLINE_HINTS = new Set(["anthropic-messages", "bedrock-converse"])
//   - OpenAI 隐式前缀缓存、 Gemini 隐式 + CachedContent API → 不需要 inline 标记

makeHint(ttlSeconds) → CacheHint({ type: "ephemeral", ttlSeconds? })

markLastTool  → 给 tools 末尾加 cache hint（若已有则 noop）
markLastSystem → 给 system 末尾加 cache hint
markMessages(strategy, hint):
  - "latest-user-message" → messages 中最后一个 user role
  - "latest-assistant"    → 最后一个 assistant role
  - { tail: n }           → 末尾 n 条全部 mark
  - 同一 message 内：优先最后一个 text part，否则最后一个 part（覆盖 tool-result-only 场景）

applyCachePolicy(request):
  if (!RESPECTS_INLINE_HINTS.has(route.id)) return request      // 跳过 OpenAI/Gemini
  const policy = resolve(request.cache)
  if (!policy.tools && !policy.system && !policy.messages) return request
  const hint = makeHint(policy.ttlSeconds)
  const tools    = policy.tools    ? markLastTool(...)
  const system   = policy.system   ? markLastSystem(...)
  const messages = policy.messages ? markMessages(...)
  if (三者都 === 原值) return request
  return LLMRequest.update(request, { tools, system, messages })
```

`CacheHint.ttlSeconds` 在降低到 wire 标记时通过 `ttlBucket` 映射：`>=3600` → `"1h"`，否则省略（默认 5m）。最终 `anthropic-messages` 与 `bedrock-converse` 的 body builder 在 builder 内部对 hint 数做 `> 4` 截断，剩余计数由 `Breakpoints` 维护；被丢弃的断点会自增 `dropped` 计数，便于 telemetry。

#### 4.3.3 `LLMRequest.cache` 默认

- `undefined` → 走 `"auto"`：tools + system + 最新 user message 三处断点。Anthropic/Bedrock 5m 缓存写 1.25x、读 0.1x，单次 5 分钟内复用即回本。
- `"auto"` 同上；`"none"` 关闭；对象形式可单独覆盖 `tools` / `system` / `messages` / `ttlSeconds`。

### 4.4 共享工具（`protocols/shared.ts`）

```ts
// JSON 编解码
Json            = Schema.fromJsonString(Schema.Unknown)
decodeJson      = Schema.decodeUnknownSync(Json)
encodeJson      = Schema.encodeSync(Json)
JsonObject      = Schema.Record(Schema.String, Schema.Unknown)
optionalArray   = <S>(schema) => Schema.optional(Schema.Array(schema))
optionalNull    = <S>(schema) => Schema.optional(Schema.NullOr(schema))

// OpenAI tool schema：必须顶层扁平 object
openAiToolInputSchema(schema: JsonSchema): JsonSchema    // 处理 anyOf → properties
removeNullSchemas(value): unknown

// Tool 流累加器（最低保证）：
interface ToolAccumulator { id, name, input }

// Usage.totalTokens 共享策略：provider 给的 total 优先；否则 input + output（仅当至少一个已知）
totalTokens(input?, output?, total?): number | undefined
subtractTokens(total?, subtrahend?): number | undefined   // max(0, total - subtrahend)
sumTokens(...values): number | undefined                  // 全 undefined 时返回 undefined（不伪造 0）

// 错误构造：
eventError(route, message, raw?)    → LLMError(module="ProviderShared", method="stream", reason=InvalidProviderOutput)
invalidRequest(message)             → LLMError(module="ProviderShared", method="request", reason=InvalidRequest)
parseJson(route, input, message)    → Effect<unknown, LLMError>    // parse 失败 → eventError
parseToolInput(route, name, raw)    → parseJson(route, raw || "{}", `Invalid JSON input for ${route} tool call ${name}`)
errorText(error)                    → string

// 文本
joinText(parts)                                       → string
escapeSystemUpdateText(text)                          → string (XML escape)
wrapSystemUpdate(parts)                               → "<system-update>\n...\n</system-update>"
systemUpdateText(route, message)                     → Effect<TextPart[]>     // 仅允许 text
wrappedSystemUpdate(route, message)                  → Effect<{type:"text",text,cache?}>

// 流帧
sseFraming(bytes) → Stream<string, LLMError>          // 见 §3.3

// 内容类型
matchToolChoice(route, choice, cases)                → Effect<Auto|None|Required|Tool, LLMError>
supportsContent<Type>(part, types)                   → part is Extract<...>
unsupportedContent(route, role, types)               → LLMError (InvalidRequest)

// Schema 校验包装
validateWith<A,I,E>(decode) → (payload) => decode(payload).pipe(Effect.mapError(invalidRequest))

// HTTP POST + JSON
jsonPost({ url, body, headers? }): HttpClientRequest  // 自动设置 content-type
```

`ProviderShared` 还定义了：

```ts
IMAGE_MIMES              = ["image/png","image/jpeg","image/gif","image/webp"]
MAX_MEDIA_ENCODED_BYTES  = 8 * 1024 * 1024             // base64 后字节
MAX_MEDIA_DECODED_BYTES  = 6 * 1024 * 1024             // 解码后字节
base64Pattern            = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

interface ValidatedMedia { mime, base64, dataUrl, bytes }
validateMedia(route, part: MediaPart, supportedMimes: Set<string>): Effect<ValidatedMedia, LLMError>

trimBaseUrl(value)                                     // 去掉末尾 /
toolResultText(part: ToolResultPart)                   // 把 ToolResultValue 序列化为纯文本
```

---

## 5. 重试策略（`session/retry.ts`）

### 5.1 常量

```ts
const RETRY_INITIAL_DELAY         = 2_000               // 2s
const RETRY_BACKOFF_FACTOR        = 2                   // 指数因子
const RETRY_MAX_DELAY_NO_HEADERS  = 30_000              // 无 retry-after header 的最大等待 30s
const RETRY_MAX_DELAY             = 2_147_483_647       // 32-bit 有符号上限，避免 setTimeout 溢出

const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
const GO_UPSELL_URL     = "https://opencode.ai/go"
type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

interface Retryable {
  message: string
  action?: {
    reason:     RetryReason
    provider:   string
    title:      string
    message:    string
    label:      string
    link?:      string
  }
}
```

### 5.2 `delay(attempt, error?)`

```ts
function delay(attempt: number, error?: APIError): number {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      // 1) retry-after-ms（毫秒）
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) return cap(parsedMs)
      }
      // 2) retry-after（秒数或 HTTP date）
      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds))
          return cap(Math.ceil(parsedSeconds * 1000))
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0)
          return cap(Math.ceil(parsed))
      }
      // 3) 否则退化指数退避
      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
    }
  }
  return cap(Math.min(
    RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1),
    RETRY_MAX_DELAY_NO_HEADERS,
  ))
}
```

退避序列（无 header）：2s → 4s → 8s → 16s → 30s（被 `RETRY_MAX_DELAY_NO_HEADERS` 截断）→ 30s …

`retry-after-ms` 与 `retry-after` 同时存在时，毫秒值优先；都解析失败才退化指数退避。所有结果都用 `cap(ms) = min(ms, RETRY_MAX_DELAY)` 截断。

### 5.3 `retryable(error, provider): Retryable | undefined`

判定规则（按顺序）：

1. **ContextOverflowError** → `undefined`（永不重试）。
2. **APIError**：
   - 若 `!isRetryable && !(status >= 500)` → `undefined`（不可重试）。
   - `responseBody` 含 `FreeUsageLimitError` → 触发 Go upsell 提示。
   - `responseBody` 含 `GoUsageLimitError` → 解析 `metadata.workspace` / `limitName` / `retryAfter` 计算 `resetIn`（days/hours/minutes），返回带 `link: https://opencode.ai/workspace/{workspace}/go` 的提示。
   - 其余 `message` 含 `Overloaded` → `"Provider is overloaded"`，否则透传 `error.data.message`。
3. **其他（plain text / JSON）**：
   - `lower(message)` 含 `"rate increased too quickly"` / `"rate limit"` / `"too many requests"` → 视为限流。
   - `JSON.type === "error" && error.type === "too_many_requests"` → `"Too Many Requests"`。
   - `JSON.code` 含 `"exhausted"` 或 `"unavailable"` → `"Provider is overloaded"`。
   - `JSON.type === "error" && JSON.error.code` 含 `"rate_limit"` → `"Rate Limited"`。
   - 其余 → `undefined`（不重试）。

### 5.4 `policy({ provider, parse, set })`

返回 `Schedule.fromStepWithMetadata`：

```ts
Schedule.fromStepWithMetadata(
  Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
    const error = opts.parse(meta.input)                 // NamedError.toObject()
    const retry = retryable(error, opts.provider)
    if (!retry) return Cause.done(meta.attempt)
    return Effect.gen(function* () {
      const wait = delay(meta.attempt, APIError.isInstance(error) ? error : undefined)
      const now  = yield* Clock.currentTimeMillis
      yield* opts.set({
        attempt: meta.attempt,
        message: retry.message,
        action:  retry.action,
        next:    now + wait,                              // UI 展示倒计时
      })
      return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
    })
  }),
)
```

调用方：

- `parse` —— 把任意 error 投影成 `{ message, responseHeaders?, responseBody?, statusCode?, isRetryable? }`。
- `set` —— 把重试状态推回 session state（含 `next` 倒计时戳，UI 可订阅显示）。
- 终止条件：`retryable(...) === undefined`，返回 `Cause.done(meta.attempt)` → 调度器终止。

### 5.5 与 `LLMError.retryable` 的关系

`session/retry.ts` 是 session 层（应用层）的策略；`LLMError.retryable` 是 schema 层字段（`RateLimit` / `ProviderInternal` 为 true，其余 false）。两者解耦：

- **schema 层**：route / protocol 抛出的 `LLMError` 自带 `retryable` 与 `retryAfterMs`（如 `RateLimit`）。
- **session 层**：在 try/catch 边界把 SDK 的 `APIError`（`@ai-sdk/*` 风格）映射成 `Retryable` 并跑指数退避；只有 `retryable(...)` 非空才继续。
- 上下文溢出在两层都“不可重试”：`isContextOverflow` → `LLMError(InvalidRequest, classification="context-overflow")`，同时 `retryable(error, provider)` 直接返回 `undefined`（context overflow 走压缩路径而非重试）。

---

## 6. 上下文溢出检测（`provider-error.ts`）

```ts
import { Schema } from "effect"
import { LLMError, ProviderErrorEvent } from "./schema"

const patterns = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
]

export const isContextOverflow = (message: string) =>
  patterns.some((pattern) => pattern.test(message)) ||
  /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)            // 400/413 无 body

export const isContextOverflowFailure = (failure: unknown) =>
  failure instanceof LLMError
    ? failure.reason._tag === "InvalidRequest"
      && failure.reason.classification === "context-overflow"
    : Schema.is(ProviderErrorEvent)(failure)
      && failure.classification === "context-overflow"
```

共 **19** 条 provider 原始报错正则 + **1** 条状态码 fallback（400/413 + 无 body）。命中后映射为：

- `LLMError` 形态：`reason = InvalidRequestReason({ message, classification: "context-overflow" })`
- 流内事件形态：`ProviderErrorEvent({ message, classification: "context-overflow", retryable: false })`

---

## 7. c0de-agent LLM 模块具体设计

### 7.1 文件布局

```text
src/llm/
├── provider.ts                 // Provider 工厂 / 注册表
├── route/
│   ├── protocol.ts             // 复刻 opencode Protocol<Body, Frame, Event, State>
│   ├── endpoint.ts             // baseURL + path + query
│   ├── framing.ts              // sse / aws-event-stream
│   └── client.ts               // Route.make / LLMClient.{prepare, stream, generate}
├── schema/
│   ├── ids.ts                  // ProtocolID/ModelID/ProviderID/...
│   ├── options.ts              // HttpOptions/GenerationOptions/Model/CacheHint/CachePolicy
│   ├── messages.ts             // SystemPart/ContentPart/Message/ToolDefinition/LLMRequest
│   ├── events.ts               // Usage + 16 事件类型 + LLMResponse + PreparedRequest
│   └── errors.ts               // HttpContext + 10 LLMErrorReason + LLMError + ToolFailure
├── protocols/
│   ├── shared.ts               // sseFraming / validateWith / parseToolInput / system update
│   ├── anthropic-messages.ts
│   ├── bedrock-converse.ts
│   ├── bedrock-event-stream.ts
│   ├── openai-chat.ts / openai-responses.ts / openai-compatible-chat.ts
│   ├── gemini.ts
│   └── utils/
│       ├── tool-stream.ts      // empty / start / appendOrStart / appendExisting /
│       │                       // finish / finishWithInput / finishAll
│       ├── lifecycle.ts        // initial/stepStart/textDelta/.../finish
│       ├── cache.ts            // newBreakpoints(4) + ttlBucket
│       ├── openai-options.ts
│       ├── gemini-tool-schema.ts
│       └── bedrock-{auth,cache,media}.ts
├── cache-policy.ts             // applyCachePolicy
├── provider-error.ts           // isContextOverflow / isContextOverflowFailure (19+1 正则)
├── retry.ts                    // RETRY_* + delay/retryable/policy
├── registry.ts                 // Model 注册表 + capability DB
├── token.ts                    // estimateTokens
└── index.ts
```

### 7.2 协议注册

```ts
import { Route, HttpTransport } from "./route/client"
import { Framing } from "./route/framing"
import { OpenAIChatProtocol } from "./protocols/openai-chat"
import { AnthropicMessagesProtocol } from "./protocols/anthropic-messages"
import { GeminiProtocol } from "./protocols/gemini"
import { BedrockConverseProtocol } from "./protocols/bedrock-converse"

export const OpenAIChatRoute = Route.make({
  id:       "openai-chat",
  provider: "openai",
  protocol: OpenAIChatProtocol,
  endpoint: { baseURL: "https://api.openai.com", path: "/v1/chat/completions" },
  auth:     Auth.bearer({ apiKey: process.env.OPENAI_API_KEY }),
  framing:  Framing.sse,
})

export const OpenAIResponsesRoute = Route.make({ id:"openai-responses", ..., endpoint: ".../v1/responses" })
export const AnthropicMessagesRoute = Route.make({
  id: "anthropic-messages",
  protocol: AnthropicMessagesProtocol,
  endpoint: { baseURL: "https://api.anthropic.com", path: "/v1/messages" },
  headers: () => ({ "anthropic-version": "2023-06-01" }),
})
export const GeminiRoute = Route.make({
  id: "gemini",
  protocol: GeminiProtocol,
  endpoint: { baseURL: "https://generativelanguage.googleapis.com",
              path: (i) => `/v1beta/models/${i.body.model}:streamGenerateContent` },
  auth: Auth.query("key", process.env.GEMINI_API_KEY),
})
export const BedrockConverseRoute = Route.make({
  id: "bedrock-converse",
  protocol: BedrockConverseProtocol,
  framing:  Framing.awsEventStream,                          // 二进制帧
  endpoint: { baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
              path: (i) => `/model/${i.body.modelId}/converse-stream` },
  auth: Auth.sigv4({ region: "us-east-1" }),
})

// 共享协议的二次部署（DeepSeek / Together / Groq / Fireworks / Cerebras …）
export const OpenAICompatRoute = (provider: string, baseURL: string, apiKey: string) =>
  OpenAIChatRoute.with({ id: provider, provider, endpoint: { baseURL, path: "/v1/chat/completions" },
                         auth: Auth.bearer({ apiKey }) })
```

### 7.3 调用范式

```ts
import { LLMClient } from "./llm/route/client"
import { ToolStream } from "./llm/protocols/utils/tool-stream"
import { Lifecycle } from "./llm/protocols/utils/lifecycle"
import { ToolExecution } from "./llm/tool-runtime"

// 1) 编译检查（不发送）
const prepared = yield* LLMClient.prepare<OpenAIChatBody>({
  model: OpenAIChatRoute.model({ id: "gpt-4o", provider: "openai" }),
  system: [SystemPart.make("You are a helpful assistant.")],
  messages: [Message.user("Hello")],
  tools: [],
})

// 2) 流式消费
const stream = LLMClient.stream({ ...prepared.model, ... })
let state = Lifecycle.initial()
const toolState = ToolStream.empty<string>()
for await (const event of Stream.runAsyncIterable(stream)) {
  if (LLMEvent.is.textDelta(event)) process.stdout.write(event.text)
  if (LLMEvent.is.toolCall(event))   yield* ToolExecution.execute(event)
}

// 3) 非流
const response = yield* LLMClient.generate(request)
response.text       // 完整文本
response.reasoning  // 完整 reasoning
response.toolCalls  // ToolCall[]
response.usage      // Usage
```

### 7.4 错误处理契约

```ts
// Protocol 内部：构造体错误
const body = Schema.decodeUnknownEffect(route.body.schema)(raw)
  .pipe(Effect.mapError((e) => ProviderShared.invalidRequest(e.message)))

// 流错误统一为 LLMError(reason=InvalidProviderOutput)
eventError(route, "Invalid OpenAI stream event", JSON.stringify(frame))

// 上下文溢出：provider-error 正则 → reason.classification = "context-overflow"
if (isContextOverflow(errorMessage))
  throw new LLMError({ module, method, reason: new InvalidRequestReason({
    message: errorMessage, classification: "context-overflow"
  })})

// session 层调度：见 §5
const schedule = policy({ provider, parse, set })
yield* Effect.retry(streamEffect, schedule)
```

### 7.5 缓存策略默认值

- `request.cache === undefined` → 走 `AUTO`（tools + system + 最新 user message 三处断点）。
- `provider` 不是 `anthropic-messages` / `bedrock-converse` → 跳过 `applyCachePolicy`（OpenAI/Gemini 不需要 inline hint）。
- `CacheHint.ttlSeconds ≥ 3600` → wire marker 写 `"1h"`；否则省略（5m 默认）。
- `tools`/`system`/`messages` 总数 > 4 时，超额部分按 §4.3.1 的 `Breakpoints` 丢弃并在 telemetry 上报。

### 7.6 角色路由 + Fallback（沿用 opencode 思路但用 c0de-agent 自己的注册表）

```ts
type ModelRole = "default" | "smol" | "slow" | "plan" | "commit"
type FallbackChain = { primary: string, fallbacks: string[], retryDelay: number, maxRetries: number }

function resolveModel(role: ModelRole): { provider: ProviderID, model: ModelID } { ... }
function chatStreamWithFallback(request: LLMRequest, chain: FallbackChain): Stream<LLMEvent, LLMError> {
  return Stream.unwrap(Effect.gen(function* () {
    for (const target of [chain.primary, ...chain.fallbacks]) {
      const policy = SessionRetry.policy({
        provider: target,
        parse: (e) => NamedError.toObject(e),
        set:    (s) => updateSessionRetryState(s),        // UI 倒计时
      })
      const attempt = LLMClient.stream({ ...request, model: targetModel })
      const outcome = yield* Effect.retry(attempt, policy)
      return outcome
    }
    return yield* Effect.fail(new NoRouteReason({ route, provider, model }))
  }))
}
```

Fallback 触发条件（与 `retryable()` 一致）：

- 429（rate limit）→ 退避后重试；超过 `maxRetries` 切 fallback。
- 5xx / ProviderInternal（retryable）→ 立即切 fallback（因为 transport 已经在指数退避）。
- 401/403 / Authentication（不可重试）→ 立即切 fallback。
- Context overflow（不可重试）→ 不切 fallback，直接交给 session.compaction。

### 7.7 Provider 特定实现细节（与 opencode 一致）

- **OpenAI**：Chat Completions `/v1/chat/completions`；Responses `/v1/responses`。`tool_calls[].function.{name,arguments}`；reasoning 通过 `reasoning` 字段；自动前缀缓存无需显式控制；`data: {JSON}\n\n` + `data: [DONE]`。
- **Anthropic**：Messages `/v1/messages`；`content[].type === "tool_use"`；`content[].type === "thinking"`（extended thinking）→ `ReasoningStart/Delta/End`，加密的 `thinking` → `ReasoningPart.encrypted`；显式 `cache_control: { type: "ephemeral", ttl? }`；`event: {type}\ndata: {JSON}\n\n`；必带 `anthropic-version` 与 `anthropic-beta`（按 feature）。
- **Google Gemini**：`POST /v1beta/models/{model}:streamGenerateContent`；`functionCall.{name, args}`；`thought: true` → reasoning；Context Caching API（`cachedContents`）；SSE 返回 JSON 对象不是 `data: ` 字符串（仍可走 `Framing.sse` + schema 解码）。
- **DeepSeek**：OpenAI 兼容 `/v1/chat/completions`；`reasoning_content` 字段；自动前缀缓存；`deepseek-reasoner` 的 thinking 独立字段。
- **OpenAI 兼容适配器**：覆盖 Groq / Together / Fireworks / Mistral / Cerebras / OpenRouter 等，统一使用 `OpenAIChatProtocol`，差异通过 route defaults（`headers`、`providerOptions`、`http`）注入；通过 `/v1/models` 自动探测能力（独立于 `protocol`）。

---

## 8. 关键不变量 / 设计原则

- **协议 = Body + Stream**：`Protocol<Body, Frame, Event, State>` 是语义 API 合约，与部署无关；`Route.make` 把 Protocol + Endpoint + Auth + Framing 组合成可运行路由。这允许 DeepSeek、TogetherAI、Cerebras 等多家共享 `OpenAIChatProtocol` 而无需复制 300 行/家。
- **compile 是重要边界**：通用 `LLMRequest` → 校验过的 provider body + transport-private prepared，但不执行传输。`LLMClient.prepare` 与 `LLMClient.stream` 都经过同一 `compile`，保证 prepare 与 stream 行为一致。
- **错误分层**：`LLMError.reason._tag` 决定路由层能否重试；`reason.classification === "context-overflow"` 触发压缩路径而非退避。`session/retry.ts` 的 `retryable()` 与 `LLMError.retryable` 解耦——前者处理 SDK 层 `APIError`，后者处理 schema 层 typed errors。
- **工具流以 `ToolStream.empty/start/appendOrStart/appendExisting/finish/finishWithInput/finishAll` 七函数覆盖所有 provider 形态**：OpenAI Chat 用 `appendOrStart` + `finishAll`；Anthropic/Bedrock/Responses 用 `start` + `appendExisting` + `finish`/`finishWithInput`。
- **缓存断点 4 上限 + TTL 分桶**：Anthropic/Bedrock 同时实施；TTL `>=3600s` → `"1h"`，否则省略（provider 默认 5m）。其他 provider 通过 `applyCachePolicy` 直接 noop。
- **Usage 字段独立存储**：`nonCachedInput + cacheRead + cacheWrite === input`；下游从不需做减法，避免 clamp 误伤。
- **System update 走 text-only**：`Message.system()` 是特权角色，禁止注入检索/工具/web 内容；不支持时降级为 `<system-update>` 包裹的可见用户文本（XML escape 防 wrapper 闭合）。
- **Tool failure 是契约**：handler 抛 `ToolFailure` → `tool-error` 事件 + `type: "error"` 的 `tool-result`，让模型自纠正；其他抛出视为缺陷并中断流。
- **WebSocket 传输已预留**：`route/transport/websocket.ts` 与 `WebSocketExecutor.Service` 是可选项；Layer 通过 `Effect.serviceOption` 注入，HTTP-only 部署零开销。
