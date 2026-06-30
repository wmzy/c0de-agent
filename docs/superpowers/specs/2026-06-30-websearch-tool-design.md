# websearch 工具设计

**日期**：2026-06-30
**关联**：主 spec §5.4 工具表（`websearch` 行）、§5.1 文件结构（`builtin/websearch.ts`）
**参考实现**：`../oh-my-pi/packages/coding-agent/src/web/search/`（多后端 strategy 架构，裁剪适配）
**状态**：待实现（P2 内置工具里程碑第 1 项）

---

## 1. 概述

为 c0de-agent 新增网络搜索工具，让 agent 能获取知识截止之外的最新信息。采用**多后端可插拔**架构（参考 oh-my-pi，裁剪其耦合项）：

- **DuckDuckGo**（默认，零 key，开箱即用）—— Instant Answer JSON API
- **Tavily**（可选，AI 优化搜索，需 key）—— 返回合成答案 + 来源
- **Brave**（可选，独立索引，需 key）

裁剪理由：oh-my-pi 支持 20+ provider，但耦合其 `pi-ai` 包、`AuthStorage` broker、`arktype`、class 范式与自动 provider chain，无法直接移植。c0de-agent 取 3 个代表性后端（零 key 默认 / AI 搜索 / 独立索引），strategy 接口预留未来扩展。本设计遵循 c0de-agent 的 **data + functions** 范式（无 class）、NodeNext ESM（`.js` import）、Config 配置。

## 2. 后端架构（strategy 函数接口）

```typescript
/** 后端标识。strategy 接口预留，未来可加 'exa' | 'searxng' | ... */
type WebSearchProviderId = 'duckduckgo' | 'tavily' | 'brave'

/** 统一搜索参数。 */
type WebSearchParams = {
  query: string
  limit?: number                 // 期望结果数（默认 8，clamp [1, 20]）
  recency?: Recency              // 时效过滤
  signal?: AbortSignal           // 中止信号，透传给 fetch
  apiKey?: string                // Tavily/Brave 的 key（DuckDuckGo 不用）
  fetchImpl?: typeof fetch       // 测试注入；默认用模块内 createFetch()
}

/** 时效过滤窗口。各后端映射为各自 API 参数（见 §4）。 */
type Recency = 'day' | 'week' | 'month' | 'year'

/** 单条搜索来源。 */
type WebSearchSource = {
  title: string
  url: string
  snippet?: string
}

/** 统一响应。 */
type WebSearchResponse = {
  provider: WebSearchProviderId
  answer?: string                // Tavily 返回合成答案；DuckDuckGo/Brave 无
  sources: WebSearchSource[]
}

/** 后端 strategy 接口（data + functions，非 class）。 */
type WebSearchProvider = {
  id: WebSearchProviderId
  /** 是否当前可用（DuckDuckGo 恒真；Tavily/Brave 需 key）。驱动 'auto' 选择。 */
  isAvailable: (apiKey?: string) => boolean
  /** 执行搜索。 */
  search: (params: WebSearchParams) => Promise<WebSearchResponse>
}
```

`'auto'` 选择优先级：`tavily`（配了 key）→ `brave`（配了 key）→ `duckduckgo`（兜底，恒可用）。显式指定 provider 时，需 key 的后端未配 key 则返回错误。

## 3. 类型与注册表（`src/tools/websearch/types.ts`）

```typescript
export type { Recency, WebSearchParams, WebSearchProvider, WebSearchProviderId, WebSearchSource, WebSearchResponse }

/** 工具参数校验常量。 */
export const DEFAULT_NUM_RESULTS = 8
export const MAX_NUM_RESULTS = 20
export const MIN_NUM_RESULTS = 1

/** clamp 结果数到 [MIN, MAX]。 */
export function clampNumResults(n: number | undefined, fallback = DEFAULT_NUM_RESULTS): number
```

后端注册（`src/tools/websearch/index.ts`）：

```typescript
import { duckduckgoProvider } from './providers/duckduckgo.js'
import { tavilyProvider } from './providers/tavily.js'
import { braveProvider } from './providers/brave.js'

const PROVIDERS: Record<WebSearchProviderId, WebSearchProvider> = {
  duckduckgo: duckduckgoProvider,
  tavily: tavilyProvider,
  brave: braveProvider,
}

/** 按 Config/环境解析目标 provider。 */
export function resolveProvider(
  preference: 'auto' | WebSearchProviderId,
  keys: { tavily?: string; brave?: string },
): WebSearchProvider

/** 工具入口：解析 provider → search → formatForLLM。config 由调用方（createWebSearchTool 工厂）传入。 */
export async function runWebSearch(
  input: { query: string; numResults?: number; recency?: Recency },
  config: WebSearchConfig,
  abort: AbortSignal,
): Promise<WebSearchResponse>
```

## 4. 后端实现（`src/tools/websearch/providers/`）

### 4.1 DuckDuckGo（`duckduckgo.ts`，零 key 默认）

Instant Answer JSON API：

- **请求**：`GET https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1&t=c0de-agent`
- **认证**：无
- **响应字段**：`AbstractText` / `AbstractURL` / `Answer` / `Definition` / `Heading` / `Results[]` / `RelatedTopics[]`
- **解析**：
  - `answer`：取 `AbstractText` || `Answer` || `Definition`（trim 后非空）
  - `sources`：`Results[]` + 递归遍历 `RelatedTopics[]`（节点形如 `{ FirstURL, Text, Topics[] }`），每条 → `{ title: Text || FirstURL, url: FirstURL, snippet: Text }`，去重（按 url）
- **recency**：Instant Answer API 不支持时效过滤，**忽略**（不重写 query、不改其他参数）
- **限制**：Instant Answer 覆盖面有限（只返回知识图谱式摘要 + 相关主题，非完整 SERP）。作为零 key 兜底可接受；配了 key 的用户应切 Tavily/Brave。
- `isAvailable`：恒 `true`

### 4.2 Tavily（`tavily.ts`，AI 搜索，需 `TAVILY_API_KEY`）

- **请求**：`POST https://api.tavily.com/search`
- **header**：`Content-Type: application/json`、`Authorization: Bearer ${apiKey}`
- **body**：
  ```json
  { "query": "...", "search_depth": "basic", "max_results": 8,
    "include_answer": "advanced", "include_raw_content": false,
    "time_range": "day|week|month|year" }
  ```
  `time_range` 仅当 `recency` 设置时附加。**始终用默认 `general` topic**（oh-my-pi 实测教训：`topic=news` 会把技术查询窄化到新闻索引，破坏 release notes / docs / GitHub 类查询）。
- **响应**：`{ answer?, results: [{ title, url, content, published_date }], request_id? }`
- **解析**：`answer` = `answer?.trim()`；`sources` = `results.map(r => ({ title: r.title ?? r.url, url: r.url, snippet: r.content }))`，过滤无 `url` 的项，`slice(0, numResults)`
- **错误**：非 2xx → 解析 `{detail|error|message}` 取消息，抛带状态码的错误
- `isAvailable`：`Boolean(apiKey)`

### 4.3 Brave（`brave.ts`，独立索引，需 `BRAVE_API_KEY`）

- **请求**：`GET https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${numResults}`
- **header**：`X-Subscription-Token: ${apiKey}`、`Accept: application/json`、`Accept-Encoding: gzip`
- **freshness 映射**（recency）：`day→pd`、`week→pw`、`month→pm`、`year→py`（≤24h/7d/31d/365d）；未设则不附加
- **响应**：`{ web: { results: [{ title, url, description, age? }] } }`
- **解析**：`sources` = `results.map(r => ({ title: r.title ?? r.url, url: r.url, snippet: r.description }))`，过滤无 `url` 的项
- `isAvailable`：`Boolean(apiKey)`

## 5. 工具定义（`src/tools/websearch/websearch.ts`）

```typescript
export const websearchTool: ToolDef = {
  name: 'websearch',
  description:
    'Search the web for up-to-date information beyond knowledge cutoff. ' +
    'Returns titled sources with snippets (and a synthesized answer when the ' +
    'backend supports it). Use for current events, recent releases, and docs. ' +
    `The current year is ${new Date().getFullYear()}.`,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      numResults: { type: 'number', description: 'Number of results (default 8, max 20)' },
      recency: {
        type: 'string',
        enum: ['day', 'week', 'month', 'year'],
        description: 'Time filter for results',
      },
    },
    required: ['query'],
  },
  permission: 'auto',
  timeout: 30_000,
  execute: async (input, ctx) => { /* resolveProvider → search → formatForLLM → ToolResult */ },
}
```

`execute` 流程（config 由 `createWebSearchTool(config)` 工厂闭包捕获，见 §7 方案 A）：
1. 解析 keys（环境变量优先于 `config.tavilyApiKey`/`braveApiKey`）
2. `resolveProvider(config.provider, keys)` 选后端
3. 调 `provider.search({ query, limit: numResults, recency, signal: ctx.abort, fetchImpl })`
4. `formatForLLM(response)` → `{ _tag: 'success', output }`
5. 无结果 → `{ _tag: 'success', output: 'No search results found. Try a different query.' }`
6. 网络错误/key 缺失 → `{ _tag: 'error', error }`

### 输出格式（`formatForLLM`）

```
<answer 若有>

## Sources (N)
[1] Title
    https://url
    snippet…（截断 240 字符）
[2] ...
```

## 6. 代理处理（`src/tools/websearch/fetch.ts`）

AGENTS.md 规定代理端口 7890。Node 内置 `fetch` **不自动走系统代理**。新增 `undici` 依赖，封装：

```typescript
import { ProxyAgent } from 'undici'

/** 读 HTTPS_PROXY/HTTP_PROXY 环境变量，有则返回带 dispatcher 的 fetch，无则返回全局 fetch。 */
export function createFetch(): typeof fetch {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (!proxy) return fetch
  const dispatcher = new ProxyAgent(proxy)
  return (url, init) => fetch(url, { ...init, dispatcher } as RequestInit)
}
```

- **新增依赖**：`undici`（runtime dependency；纯 JS，零原生编译；Node 22 内置其作为 fetch 实现但 npm 包提供 `ProxyAgent` 导出与类型）
- duckduckgo/tavily/brave 默认 `fetchImpl = createFetch()`，测试注入 mock
- 不用 `setGlobalDispatcher`（避免污染全局，仅影响 websearch 模块）

## 7. 配置（`src/shared/types/config.ts`）

`Config` 新增 `websearch` 块：

```typescript
type WebSearchConfig = {
  /** 后端选择。'auto'（默认）→ 按 key 可用性：tavily > brave > duckduckgo。 */
  provider: 'auto' | WebSearchProviderId
  /** Tavily key；也可由环境变量 TAVILY_API_KEY 提供（环境变量优先）。 */
  tavilyApiKey?: string
  /** Brave key；也可由环境变量 BRAVE_API_KEY 提供（环境变量优先）。 */
  braveApiKey?: string
}

// Config 新增字段
type Config = {
  // … 既有字段不变 …
  websearch: WebSearchConfig
}
```

key 解析优先级：环境变量 `TAVILY_API_KEY` / `BRAVE_API_KEY` > `config.websearch.tavilyApiKey` / `braveApiKey`。默认配置（`src/core/config.ts`）`websearch: { provider: 'auto' }`。

### `ToolContext` 接线

`ToolContext` 当前无 config 字段。两种方案：
- **方案 A（推荐）**：`websearchTool.execute` 在模块初始化时通过闭包捕获 config（server 启动时 `createWebSearchTool(config)` 工厂）。与 `runSubAgent` / `debugSpawn` 的依赖反转模式一致。
- 方案 B：扩展 `ToolContext` 加 `config?: Config`。侵入性更大，暂不取。

采用方案 A：`createDefaultRegistry()` 改为接收可选 config，`websearchTool` 由工厂构造：

```typescript
export function createWebSearchTool(config: WebSearchConfig): ToolDef
```

## 8. 文件结构

```
src/tools/websearch/
├── types.ts              WebSearchSource/Response/Params/Provider/Recency + clampNumResults + 常量
├── fetch.ts              createFetch()（undici ProxyAgent）
├── index.ts              PROVIDERS 注册表 + resolveProvider + runWebSearch + formatForLLM
├── websearch.ts          createWebSearchTool(config) → ToolDef
├── providers/
│   ├── duckduckgo.ts     Instant Answer API
│   ├── tavily.ts         Tavily API
│   └── brave.ts          Brave API
└── *.test.ts             （见 §9）
```

注册：`src/tools/index.ts` 导出 `createWebSearchTool`；`createDefaultRegistry(config?)` 调用之并 `registerTool`。

## 9. 测试策略

遵循 AGENTS.md 测试放置规范（websearch 是新工具，无既有 skill-tests/integration 文件适用 → 在本子包内建测试文件，文件头注明来源）。

| 测试文件 | 覆盖 |
|---------|------|
| `websearch/types.test.ts` | `clampNumResults` 边界值（0/-1/21/undefined/正常） |
| `websearch/providers/duckduckgo.test.ts` | mock fetch：解析 AbstractText/RelatedTopics 递归、去重、recency 忽略、空结果 |
| `websearch/providers/tavily.test.ts` | mock fetch：请求 body 构造（time_range 仅 recency 时附加）、answer 提取、错误状态码 |
| `websearch/providers/brave.test.ts` | mock fetch：freshness 映射、header、results 解析 |
| `websearch/index.test.ts` | `resolveProvider`（auto 优先级、显式、key 缺失）、`formatForLLM` 输出格式、`runWebSearch` 端到端（注入 mock provider） |
| `websearch/websearch.test.ts` | ToolDef：`execute` → success/error/无结果、abort 透传 |

测试范式：注入 `fetchImpl` mock（`vi.fn()` 返回构造的 `Response`），不发起真实网络请求。参考 `src/tools/builtin/grep.test.ts` 的 ToolContext mock + `execute` 直调断言 `_tag`/`output`。

## 10. 依赖变更

- **新增 runtime dependency**：`undici`（ProxyAgent）。`pnpm add undici`
- 无其他新依赖（fetch / AbortSignal 为 Node 22 内置）

## 11. 验收标准

1. `pnpm typecheck` 通过
2. `pnpm lint`（biome）通过
3. `pnpm vitest run` 全绿，新增测试覆盖 §9 全部场景
4. 工具注册到 `createDefaultRegistry`，LLM 可见 `websearch` 工具 schema
5. DuckDuckGo 后端零 key 可用（集成 smoke：可选，需网络/代理）
6. 主 spec `docs/superpowers/specs/2026-06-21-c0de-agent-design.md` §5.1/§5.4 更新（websearch 从"待实现"标注为"已实现"，补充本设计文档引用）

## 12. 非目标（YAGNI）

- 不实现 oh-my-pi 的其余 17+ provider（exa/perplexity/gemini/codex/xai/jina/kagi/parallel/searxng/firecrawl/tinyfish/zai/kimi/synthetic/anthropic/...）。strategy 接口预留，按需后续扩展。
- 不实现自动 provider chain 重试 / 故障转移（单次调用选定 provider 即可）。
- 不实现网页正文抓取（scrapers）。仅返回搜索结果摘要。完整抓取属另一工具（webfetch，未来项）。
- 不实现 provider 用量统计 / 成本追踪。
