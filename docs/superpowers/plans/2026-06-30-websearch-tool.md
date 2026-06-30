# websearch 工具实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 c0de-agent 新增多后端可插拔的 `websearch` 工具（DuckDuckGo 默认零 key + Tavily/Brave 可选），让 agent 获取知识截止之外的最新信息。

**Architecture:** strategy 函数接口（data+functions，非 class）。`WebSearchProvider` 接口 + 3 个后端实现 + 注册表 `resolveProvider`（`'auto'` 按 key 可用性：tavily > brave > duckduckgo）。工具通过 `createWebSearchTool(config)` 工厂闭包捕获配置（对齐 `runSubAgent`/`debugSpawn` 依赖反转模式）。`undici` ProxyAgent 读 `HTTPS_PROXY` 仅影响本模块。所有 import 以 `.js` 结尾（NodeNext ESM）。

**Tech Stack:** TypeScript（NodeNext ESM）、Node 22 内置 fetch、`undici`（ProxyAgent，新增 dependency）、vitest（`fetchImpl` 注入 mock，参考 `src/llm/transport.test.ts` 范式）、biome。

**设计文档：** `docs/superpowers/specs/2026-06-30-websearch-tool-design.md`
**参考实现：** `../oh-my-pi/packages/coding-agent/src/web/search/`

---

## File Structure

```
src/tools/websearch/                     （新建子包）
├── types.ts          WebSearch 类型 + clampNumResults + 常量
├── fetch.ts          createFetch()（undici ProxyAgent）
├── providers/
│   ├── duckduckgo.ts Instant Answer JSON API（零 key）
│   ├── tavily.ts     Tavily API（需 key）
│   └── brave.ts      Brave API（需 key）
├── index.ts          PROVIDERS 注册表 + resolveProvider + runWebSearch + formatForLLM
└── websearch.ts      createWebSearchTool(config) → ToolDef

测试（同目录）：
├── types.test.ts
├── fetch.test.ts
├── providers/duckduckgo.test.ts
├── providers/tavily.test.ts
├── providers/brave.test.ts
├── index.test.ts
└── websearch.test.ts

修改：
- src/shared/types/config.ts   新增 WebSearchConfig 类型
- src/core/config.ts           DEFAULT_CONFIG 加 websearch 默认块 + tools.enabled 加 'websearch'
- src/shared/types/config.test.ts  断言 websearch 默认值
- src/core/config.test.ts      断言 tools.enabled 含 websearch
- src/tools/index.ts           导出 createWebSearchTool；createDefaultRegistry(config?) 注册 websearch
- src/tools/index.test.ts      断言 registry 含 websearch
- src/cli/deps.ts              createDefaultRegistry(config) 传 config
- src/server/context.ts        createDefaultRegistry(config) 传 config
- src/server/server.ts         createDefaultRegistry(config) 传 config
- docs/superpowers/specs/2026-06-21-c0de-agent-design.md  §5.1/§5.4 标注 websearch 已实现
```

---

## Task 1: 类型与常量（`src/tools/websearch/types.ts`）

**Files:**
- Create: `src/tools/websearch/types.ts`
- Test: `src/tools/websearch/types.test.ts`

- [ ] **Step 1: 写失败测试 `src/tools/websearch/types.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { clampNumResults, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS, MIN_NUM_RESULTS } from './types.js'

describe('websearch types', () => {
  it('exposes default/min/max result constants', () => {
    expect(DEFAULT_NUM_RESULTS).toBe(8)
    expect(MIN_NUM_RESULTS).toBe(1)
    expect(MAX_NUM_RESULTS).toBe(20)
  })

  it('clampNumResults returns default for undefined', () => {
    expect(clampNumResults(undefined)).toBe(DEFAULT_NUM_RESULTS)
  })

  it('clampNumResults clamps below min', () => {
    expect(clampNumResults(0)).toBe(MIN_NUM_RESULTS)
    expect(clampNumResults(-1)).toBe(MIN_NUM_RESULTS)
  })

  it('clampNumResults clamps above max', () => {
    expect(clampNumResults(21)).toBe(MAX_NUM_RESULTS)
    expect(clampNumResults(1000)).toBe(MAX_NUM_RESULTS)
  })

  it('clampNumResults passes through in-range values', () => {
    expect(clampNumResults(5)).toBe(5)
    expect(clampNumResults(MIN_NUM_RESULTS)).toBe(MIN_NUM_RESULTS)
    expect(clampNumResults(MAX_NUM_RESULTS)).toBe(MAX_NUM_RESULTS)
  })

  it('clampNumResults honors custom fallback', () => {
    expect(clampNumResults(undefined, 3)).toBe(3)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run src/tools/websearch/types.test.ts`
Expected: FAIL — 模块不存在 / 导出缺失。

- [ ] **Step 3: 实现 `src/tools/websearch/types.ts`**

```typescript
/** 后端标识。预留扩展（未来可加 'exa' | 'searxng' | ...）。 */
type WebSearchProviderId = 'duckduckgo' | 'tavily' | 'brave'

/** 时效过滤窗口。各后端映射为各自 API 参数。 */
type Recency = 'day' | 'week' | 'month' | 'year'

/** 单条搜索来源（所有后端统一）。 */
type WebSearchSource = {
  title: string
  url: string
  snippet?: string
}

/** 统一搜索参数。 */
type WebSearchParams = {
  query: string
  limit?: number
  recency?: Recency
  signal?: AbortSignal
  /** Tavily/Brave 的 key（DuckDuckGo 不用）。 */
  apiKey?: string
  /** 测试注入；默认用 createFetch()。 */
  fetchImpl?: typeof fetch
}

/** 统一响应（所有后端统一）。 */
type WebSearchResponse = {
  provider: WebSearchProviderId
  /** Tavily 返回合成答案；DuckDuckGo/Brave 通常无。 */
  answer?: string
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

/** 工具参数校验常量。 */
const DEFAULT_NUM_RESULTS = 8
const MAX_NUM_RESULTS = 20
const MIN_NUM_RESULTS = 1

/** clamp 结果数到 [MIN, MAX]。 */
function clampNumResults(n: number | undefined, fallback: number = DEFAULT_NUM_RESULTS): number {
  if (n === undefined || Number.isNaN(n)) return fallback
  return Math.min(MAX_NUM_RESULTS, Math.max(MIN_NUM_RESULTS, Math.trunc(n)))
}

export type {
  Recency,
  WebSearchParams,
  WebSearchProvider,
  WebSearchProviderId,
  WebSearchSource,
  WebSearchResponse,
}
export { DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS, MIN_NUM_RESULTS, clampNumResults }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run src/tools/websearch/types.test.ts`
Expected: PASS（6/6）。

- [ ] **Step 5: 提交**

```bash
git add src/tools/websearch/types.ts src/tools/websearch/types.test.ts
git commit -m "feat(websearch): 类型与 clampNumResults 常量"
```

---

## Task 2: 代理感知 fetch（`src/tools/websearch/fetch.ts`）

**Files:**
- Create: `src/tools/websearch/fetch.ts`
- Test: `src/tools/websearch/fetch.test.ts`

- [ ] **Step 0: 安装依赖**

Run: `pnpm add undici`
Expected: `undici` 写入 `package.json` 的 `dependencies`。

- [ ] **Step 1: 写失败测试 `src/tools/websearch/fetch.test.ts`**

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFetch } from './fetch.js'

const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const

afterEach(() => {
  for (const k of ENV_KEYS) vi.stubEnv(k, '')
})

describe('createFetch', () => {
  it('returns global fetch when no proxy env is set', () => {
    for (const k of ENV_KEYS) vi.stubEnv(k, '')
    expect(createFetch()).toBe(fetch)
  })

  it('constructs a ProxyAgent-wrapped fetch when HTTPS_PROXY is set', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7890')
    const f = createFetch()
    // 不是全局 fetch（已包装）；仍可调用
    expect(f).not.toBe(fetch)
    expect(typeof f).toBe('function')
  })

  it('honors lowercase https_proxy variant', () => {
    vi.stubEnv('HTTPS_PROXY', '')
    vi.stubEnv('https_proxy', 'http://127.0.0.1:7890')
    expect(createFetch()).not.toBe(fetch)
  })

  it('honors HTTP_PROXY fallback', () => {
    vi.stubEnv('HTTPS_PROXY', '')
    vi.stubEnv('https_proxy', '')
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:7890')
    expect(createFetch()).not.toBe(fetch)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run src/tools/websearch/fetch.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `src/tools/websearch/fetch.ts`**

```typescript
import { ProxyAgent } from 'undici'

/**
 * 读 HTTPS_PROXY/HTTP_PROXY 环境变量，有则返回带 dispatcher 的 fetch，
 * 无则返回全局 fetch。仅影响本模块，不调用 setGlobalDispatcher（避免污染全局）。
 *
 * AGENTS.md 规定代理端口 7890；Node 内置 fetch 不自动走系统代理，故需包装。
 */
export function createFetch(): typeof fetch {
  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy
  if (!proxy) return fetch
  const dispatcher = new ProxyAgent(proxy)
  return ((url: string | URL | Request, init?: RequestInit) =>
    fetch(url, { ...init, dispatcher: dispatcher as RequestInit['dispatcher'] })) as typeof fetch
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run src/tools/websearch/fetch.test.ts`
Expected: PASS（4/4）。

- [ ] **Step 5: 提交**

```bash
git add src/tools/websearch/fetch.ts src/tools/websearch/fetch.test.ts package.json pnpm-lock.yaml
git commit -m "feat(websearch): undici ProxyAgent 代理感知 fetch"
```

---

## Task 3: DuckDuckGo 后端（`src/tools/websearch/providers/duckduckgo.ts`）

**Files:**
- Create: `src/tools/websearch/providers/duckduckgo.ts`
- Test: `src/tools/websearch/providers/duckduckgo.test.ts`

- [ ] **Step 1: 写失败测试 `src/tools/websearch/providers/duckduckgo.test.ts`**

```typescript
import { describe, expect, it, vi } from 'vitest'
import { duckduckgoProvider } from './duckduckgo.js'

/** 构造一个返回指定 JSON body 的 mock fetch。 */
function mockFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('duckduckgoProvider', () => {
  it('is always available (no key required)', () => {
    expect(duckduckgoProvider.isAvailable()).toBe(true)
    expect(duckduckgoProvider.isAvailable(undefined)).toBe(true)
  })

  it('parses AbstractText as answer', async () => {
    const f = mockFetch({
      AbstractText: 'TypeScript is a language.',
      AbstractURL: 'https://ts.dev',
      Heading: 'TypeScript',
      RelatedTopics: [],
    })
    const res = await duckduckgoProvider.search({
      query: 'typescript',
      fetchImpl: f,
    })
    expect(res.provider).toBe('duckduckgo')
    expect(res.answer).toBe('TypeScript is a language.')
    expect(res.sources).toEqual([{ title: 'TypeScript', url: 'https://ts.dev' }])
  })

  it('collects sources from RelatedTopics recursively (nested Topics)', async () => {
    const f = mockFetch({
      AbstractText: '',
      RelatedTopics: [
        { FirstURL: 'https://a.example', Text: 'Topic A' },
        {
          FirstURL: 'https://parent.example',
          Text: 'Parent',
          Topics: [{ FirstURL: 'https://nested.example', Text: 'Nested' }],
        },
      ],
    })
    const res = await duckduckgoProvider.search({ query: 'x', fetchImpl: f })
    expect(res.sources.map((s) => s.url)).toEqual([
      'https://a.example',
      'https://parent.example',
      'https://nested.example',
    ])
    expect(res.sources[2]).toEqual({
      title: 'Nested',
      url: 'https://nested.example',
      snippet: 'Nested',
    })
  })

  it('falls back title to url when Text is empty', async () => {
    const f = mockFetch({
      RelatedTopics: [{ FirstURL: 'https://notext.example', Text: '' }],
    })
    const res = await duckduckgoProvider.search({ query: 'x', fetchImpl: f })
    expect(res.sources[0]).toEqual({ title: 'https://notext.example', url: 'https://notext.example' })
  })

  it('deduplicates sources by url', async () => {
    const f = mockFetch({
      RelatedTopics: [
        { FirstURL: 'https://dup.example', Text: 'First' },
        { FirstURL: 'https://dup.example', Text: 'Second' },
      ],
    })
    const res = await duckduckgoProvider.search({ query: 'x', fetchImpl: f })
    expect(res.sources).toHaveLength(1)
    expect(res.sources[0].snippet).toBe('First')
  })

  it('ignores recency (Instant Answer API does not support time filtering)', async () => {
    const f = mockFetch({ AbstractText: '', RelatedTopics: [] })
    await duckduckgoProvider.search({ query: 'x', recency: 'day', fetchImpl: f })
    const url = vi.mocked(f).mock.calls[0][0] as string
    expect(url).toContain('q=x')
    expect(url).not.toContain('time_range')
    expect(url).not.toContain('recency')
  })

  it('returns empty sources when response is empty', async () => {
    const f = mockFetch({})
    const res = await duckduckgoProvider.search({ query: 'nothing', fetchImpl: f })
    expect(res.sources).toEqual([])
    expect(res.answer).toBeUndefined()
  })

  it('throws on non-2xx response', async () => {
    const f = mockFetch({ error: 'rate limited' }, 429)
    await expect(
      duckduckgoProvider.search({ query: 'x', fetchImpl: f }),
    ).rejects.toThrow(/429/)
  })

  it('sends GET request with required query params', async () => {
    const f = mockFetch({})
    await duckduckgoProvider.search({ query: 'react hooks', fetchImpl: f })
    const url = vi.mocked(f).mock.calls[0][0] as string
    expect(url).toContain('q=react+hooks')
    expect(url).toContain('format=json')
    expect(url).toContain('no_redirect=1')
    expect(url).toContain('no_html=1')
    expect(url).toContain('t=c0de-agent')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run src/tools/websearch/providers/duckduckgo.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `src/tools/websearch/providers/duckduckgo.ts`**

```typescript
import type { WebSearchParams, WebSearchProvider, WebSearchResponse, WebSearchSource } from '../types.js'

const DUCKDUCKGO_SEARCH_URL = 'https://api.duckduckgo.com/'
const AGENT_TOKEN = 'c0de-agent'

/** DuckDuckGo Instant Answer API 响应形状（仅取用到的字段）。 */
interface DuckDuckGoTopic {
  FirstURL?: string | null
  Text?: string | null
  Topics?: DuckDuckGoTopic[] | null
}
interface DuckDuckGoResponse {
  AbstractText?: string | null
  AbstractURL?: string | null
  Heading?: string | null
  Answer?: string | null
  Definition?: string | null
  Results?: DuckDuckGoTopic[] | null
  RelatedTopics?: DuckDuckGoTopic[] | null
}

function cleanText(value: string | null | undefined): string | undefined {
  const cleaned = value
    ?.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? cleaned : undefined
}

function addSource(sources: WebSearchSource[], source: WebSearchSource): void {
  if (!source.url || sources.some((s) => s.url === source.url)) return
  sources.push(source)
}

function addTopicSource(sources: WebSearchSource[], topic: DuckDuckGoTopic): void {
  const url = topic.FirstURL?.trim()
  if (!url) return
  const text = cleanText(topic.Text)
  addSource(sources, { title: text ?? url, url, snippet: text })
}

function collectTopicSources(
  sources: WebSearchSource[],
  topics: readonly DuckDuckGoTopic[] | null | undefined,
): void {
  if (!topics) return
  for (const topic of topics) {
    addTopicSource(sources, topic)
    collectTopicSources(sources, topic.Topics)
  }
}

async function callDuckDuckGoSearch(
  params: WebSearchParams,
): Promise<DuckDuckGoResponse> {
  const query = [
    ['q', params.query],
    ['format', 'json'],
    ['no_redirect', '1'],
    ['no_html', '1'],
    ['skip_disambig', '1'],
    ['t', AGENT_TOKEN],
  ]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const response = await params.fetchImpl(`${DUCKDUCKGO_SEARCH_URL}?${query}`, {
    method: 'GET',
    signal: params.signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText)
    throw new Error(`DuckDuckGo API error (${response.status}): ${text}`)
  }
  return (await response.json()) as DuckDuckGoResponse
}

/** DuckDuckGo Instant Answer 后端（零 key，恒可用）。recency 不支持，忽略。 */
export const duckduckgoProvider: WebSearchProvider = {
  id: 'duckduckgo',
  isAvailable: () => true,
  search: async (params: WebSearchParams): Promise<WebSearchResponse> => {
    const data = await callDuckDuckGoSearch(params)
    const answer =
      cleanText(data.AbstractText) ??
      cleanText(data.Answer) ??
      cleanText(data.Definition)
    const sources: WebSearchSource[] = []
    // AbstractURL 作为首个来源（若无 RelatedTopics 填充）
    if (data.AbstractURL) {
      addSource(sources, {
        title: cleanText(data.Heading) ?? data.AbstractURL,
        url: data.AbstractURL,
      })
    }
    collectTopicSources(sources, data.Results)
    collectTopicSources(sources, data.RelatedTopics)
    return { provider: 'duckduckgo', answer, sources }
  },
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run src/tools/websearch/providers/duckduckgo.test.ts`
Expected: PASS（9/9）。

- [ ] **Step 5: 提交**

```bash
git add src/tools/websearch/providers/duckduckgo.ts src/tools/websearch/providers/duckduckgo.test.ts
git commit -m "feat(websearch): DuckDuckGo Instant Answer 后端"
```

---

## Task 4: Tavily 后端（`src/tools/websearch/providers/tavily.ts`）

**Files:**
- Create: `src/tools/websearch/providers/tavily.ts`
- Test: `src/tools/websearch/providers/tavily.test.ts`

- [ ] **Step 1: 写失败测试 `src/tools/websearch/providers/tavily.test.ts`**

```typescript
import { describe, expect, it, vi } from 'vitest'
import { buildRequestBody, tavilyProvider } from './tavily.js'

function mockFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('tavilyProvider', () => {
  it('is available only when apiKey is provided', () => {
    expect(tavilyProvider.isAvailable()).toBe(false)
    expect(tavilyProvider.isAvailable('')).toBe(false)
    expect(tavilyProvider.isAvailable('tvly-xxx')).toBe(true)
  })

  it('buildRequestBody omits time_range when recency not set', () => {
    const body = buildRequestBody({ query: 'q', numResults: 5 })
    expect(body).toMatchObject({
      query: 'q',
      search_depth: 'basic',
      max_results: 5,
      include_answer: 'advanced',
      include_raw_content: false,
    })
    expect('time_range' in body).toBe(false)
  })

  it('buildRequestBody adds time_range when recency is set', () => {
    const body = buildRequestBody({ query: 'q', numResults: 5, recency: 'week' })
    expect(body).toMatchObject({ time_range: 'week' })
  })

  it('search posts JSON body with Bearer auth and parses answer + results', async () => {
    const f = mockFetch({
      answer: ' React 19 ',
      results: [
        { title: 'React', url: 'https://react.dev', content: 'A JS library' },
        { title: 'Docs', url: 'https://react.dev/learn', content: 'Learn' },
      ],
      request_id: 'req-1',
    })
    const res = await tavilyProvider.search({
      query: 'react',
      apiKey: 'tvly-key',
      fetchImpl: f,
    })
    expect(res.provider).toBe('tavily')
    expect(res.answer).toBe('React 19')
    expect(res.sources).toEqual([
      { title: 'React', url: 'https://react.dev', snippet: 'A JS library' },
      { title: 'Docs', url: 'https://react.dev/learn', snippet: 'Learn' },
    ])
    // 校验请求构造
    const [url, init] = vi.mocked(f).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.tavily.com/search')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tvly-key')
  })

  it('skips results without url', async () => {
    const f = mockFetch({
      results: [
        { title: 'no url', content: 'x' },
        { title: 'ok', url: 'https://ok.example', content: 'y' },
      ],
    })
    const res = await tavilyProvider.search({ query: 'q', apiKey: 'k', fetchImpl: f })
    expect(res.sources).toEqual([{ title: 'ok', url: 'https://ok.example', snippet: 'y' }])
  })

  it('falls back title to url when title missing', async () => {
    const f = mockFetch({ results: [{ url: 'https://t.example', content: 'c' }] })
    const res = await tavilyProvider.search({ query: 'q', apiKey: 'k', fetchImpl: f })
    expect(res.sources[0].title).toBe('https://t.example')
  })

  it('throws with status on non-2xx', async () => {
    const f = mockFetch({ detail: 'invalid key' }, 401)
    await expect(
      tavilyProvider.search({ query: 'q', apiKey: 'bad', fetchImpl: f }),
    ).rejects.toThrow(/401/)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run src/tools/websearch/providers/tavily.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `src/tools/websearch/providers/tavily.ts`**

```typescript
import { DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS, MIN_NUM_RESULTS } from '../types.js'
import type {
  Recency,
  WebSearchParams,
  WebSearchProvider,
  WebSearchResponse,
  WebSearchSource,
} from '../types.js'

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'

interface TavilySearchParams {
  query: string
  numResults?: number
  recency?: Recency
}

interface TavilySearchResult {
  title?: string | null
  url?: string | null
  content?: string | null
  published_date?: string | null
}
interface TavilySearchResponse {
  answer?: string | null
  results?: TavilySearchResult[]
  request_id?: string | null
}

function clamp(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) return DEFAULT_NUM_RESULTS
  return Math.min(MAX_NUM_RESULTS, Math.max(MIN_NUM_RESULTS, Math.trunc(n)))
}

/** 导出供测试：构造 Tavily 请求 body。始终用 general topic（避免技术查询窄化为新闻）。 */
export function buildRequestBody(params: TavilySearchParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: params.query,
    search_depth: 'basic',
    max_results: clamp(params.numResults),
    include_answer: 'advanced',
    include_raw_content: false,
  }
  if (params.recency) body.time_range = params.recency
  return body
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function getErrorMessage(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim()
    return t.length > 0 ? t : null
  }
  const rec = asRecord(value)
  if (!rec) return null
  for (const key of ['detail', 'error', 'message']) {
    const m = getErrorMessage(rec[key])
    if (m) return m
  }
  return null
}

async function callTavilySearch(
  apiKey: string,
  params: WebSearchParams,
): Promise<TavilySearchResponse> {
  const response = await params.fetchImpl(TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(
      buildRequestBody({ query: params.query, numResults: params.limit, recency: params.recency }),
    ),
    signal: params.signal,
  })
  if (!response.ok) {
    const raw = await response.text().catch(() => response.statusText)
    const msg = getErrorMessage(safeParse(raw)) ?? raw.trim() || response.statusText
    throw new Error(`Tavily API error (${response.status}): ${msg}`)
  }
  return (await response.json()) as TavilySearchResponse
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Tavily 后端（AI 优化搜索，需 key，返回合成 answer）。 */
export const tavilyProvider: WebSearchProvider = {
  id: 'tavily',
  isAvailable: (apiKey?: string) => Boolean(apiKey && apiKey.length > 0),
  search: async (params: WebSearchParams): Promise<WebSearchResponse> => {
    if (!params.apiKey) throw new Error('Tavily requires an API key (TAVILY_API_KEY or config).')
    const data = await callTavilySearch(params.apiKey, params)
    const sources: WebSearchSource[] = []
    for (const r of data.results ?? []) {
      if (!r.url) continue
      sources.push({ title: r.title ?? r.url, url: r.url, snippet: r.content ?? undefined })
    }
    return {
      provider: 'tavily',
      answer: data.answer?.trim() || undefined,
      sources: sources.slice(0, clamp(params.limit)),
    }
  },
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run src/tools/websearch/providers/tavily.test.ts`
Expected: PASS（7/7）。

- [ ] **Step 5: 提交**

```bash
git add src/tools/websearch/providers/tavily.ts src/tools/websearch/providers/tavily.test.ts
git commit -m "feat(websearch): Tavily AI 搜索后端"
```

---

## Task 5: Brave 后端（`src/tools/websearch/providers/brave.ts`）

**Files:**
- Create: `src/tools/websearch/providers/brave.ts`
- Test: `src/tools/websearch/providers/brave.test.ts`

- [ ] **Step 1: 写失败测试 `src/tools/websearch/providers/brave.test.ts`**

```typescript
import { describe, expect, it, vi } from 'vitest'
import { braveProvider, recencyToFreshness } from './brave.js'

function mockFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('braveProvider', () => {
  it('is available only when apiKey is provided', () => {
    expect(braveProvider.isAvailable()).toBe(false)
    expect(braveProvider.isAvailable('brave-key')).toBe(true)
  })

  it('recencyToFreshness maps recency to Brave freshness codes', () => {
    expect(recencyToFreshness('day')).toBe('pd')
    expect(recencyToFreshness('week')).toBe('pw')
    expect(recencyToFreshness('month')).toBe('pm')
    expect(recencyToFreshness('year')).toBe('py')
    expect(recencyToFreshness(undefined)).toBeUndefined()
  })

  it('sends GET with X-Subscription-Token header and count param', async () => {
    const f = mockFetch({ web: { results: [] } })
    await braveProvider.search({ query: 'rust', apiKey: 'brave-key', limit: 5, fetchImpl: f })
    const [url, init] = vi.mocked(f).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://api.search.brave.com/res/v1/web/search')
    expect(url).toContain('q=rust')
    expect(url).toContain('count=5')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('brave-key')
  })

  it('appends freshness param when recency set', async () => {
    const f = mockFetch({ web: { results: [] } })
    await braveProvider.search({ query: 'q', apiKey: 'k', recency: 'week', fetchImpl: f })
    const url = vi.mocked(f).mock.calls[0][0] as string
    expect(url).toContain('freshness=pw')
  })

  it('omits freshness when recency not set', async () => {
    const f = mockFetch({ web: { results: [] } })
    await braveProvider.search({ query: 'q', apiKey: 'k', fetchImpl: f })
    const url = vi.mocked(f).mock.calls[0][0] as string
    expect(url).not.toContain('freshness')
  })

  it('parses web.results into sources', async () => {
    const f = mockFetch({
      web: {
        results: [
          { title: 'Rust', url: 'https://rust-lang.org', description: 'A language' },
          { title: 'Docs', url: 'https://doc.rust-lang.org', description: 'Book' },
        ],
      },
    })
    const res = await braveProvider.search({ query: 'rust', apiKey: 'k', fetchImpl: f })
    expect(res.provider).toBe('brave')
    expect(res.sources).toEqual([
      { title: 'Rust', url: 'https://rust-lang.org', snippet: 'A language' },
      { title: 'Docs', url: 'https://doc.rust-lang.org', snippet: 'Book' },
    ])
  })

  it('skips results without url, falls back title to url', async () => {
    const f = mockFetch({
      web: {
        results: [{ description: 'no url' }, { url: 'https://t.example', description: 'd' }],
      },
    })
    const res = await braveProvider.search({ query: 'q', apiKey: 'k', fetchImpl: f })
    expect(res.sources).toEqual([{ title: 'https://t.example', url: 'https://t.example', snippet: 'd' }])
  })

  it('throws with status on non-2xx', async () => {
    const f = mockFetch('unauthorized', 401)
    await expect(
      braveProvider.search({ query: 'q', apiKey: 'bad', fetchImpl: f }),
    ).rejects.toThrow(/401/)
  })

  it('handles empty results gracefully', async () => {
    const f = mockFetch({ web: { results: [] } })
    const res = await braveProvider.search({ query: 'q', apiKey: 'k', fetchImpl: f })
    expect(res.sources).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run src/tools/websearch/providers/brave.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `src/tools/websearch/providers/brave.ts`**

```typescript
import type {
  Recency,
  WebSearchParams,
  WebSearchProvider,
  WebSearchResponse,
  WebSearchSource,
} from '../types.js'
import { DEFAULT_NUM_RESULTS } from '../types.js'

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'

interface BraveResult {
  title?: string | null
  url?: string | null
  description?: string | null
}
interface BraveSearchResponse {
  web?: { results?: BraveResult[] } | null
}

/** 导出供测试：recency → Brave freshness 代码映射。 */
export function recencyToFreshness(recency: Recency | undefined): string | undefined {
  switch (recency) {
    case 'day':
      return 'pd'
    case 'week':
      return 'pw'
    case 'month':
      return 'pm'
    case 'year':
      return 'py'
    default:
      return undefined
  }
}

/** Brave 后端（独立索引，需 key）。 */
export const braveProvider: WebSearchProvider = {
  id: 'brave',
  isAvailable: (apiKey?: string) => Boolean(apiKey && apiKey.length > 0),
  search: async (params: WebSearchParams): Promise<WebSearchResponse> => {
    if (!params.apiKey) throw new Error('Brave requires an API key (BRAVE_API_KEY or config).')
    const count = params.limit ?? DEFAULT_NUM_RESULTS
    const query = new URLSearchParams({ q: params.query, count: String(count) })
    const freshness = recencyToFreshness(params.recency)
    if (freshness) query.set('freshness', freshness)

    const response = await params.fetchImpl(`${BRAVE_SEARCH_URL}?${query.toString()}`, {
      method: 'GET',
      headers: {
        'X-Subscription-Token': params.apiKey,
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
      },
      signal: params.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText)
      throw new Error(`Brave API error (${response.status}): ${text}`)
    }
    const data = (await response.json()) as BraveSearchResponse
    const sources: WebSearchSource[] = []
    for (const r of data.web?.results ?? []) {
      if (!r.url) continue
      sources.push({ title: r.title ?? r.url, url: r.url, snippet: r.description ?? undefined })
    }
    return { provider: 'brave', sources }
  },
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run src/tools/websearch/providers/brave.test.ts`
Expected: PASS（9/9）。

- [ ] **Step 5: 提交**

```bash
git add src/tools/websearch/providers/brave.ts src/tools/websearch/providers/brave.test.ts
git commit -m "feat(websearch): Brave 独立索引后端"
```

---

## Task 6: 注册表、provider 选择与格式化（`src/tools/websearch/index.ts`）

**Files:**
- Create: `src/tools/websearch/index.ts`
- Test: `src/tools/websearch/index.test.ts`

## 执行顺序说明

Task 编号为逻辑分组顺序，但 **Task 6 依赖 Task 7 的 `WebSearchConfig`**，故实际执行顺序为：

**Task 7（config 类型）→ Task 1（types）→ Task 2（fetch）→ Task 3（duckduckgo）→ Task 4（tavily）→ Task 5（brave）→ Task 6（注册表）→ Task 8（ToolDef）→ Task 9（接线）→ Task 10（验证）**

Task 7 必须最先做（其他 Task 的 import 依赖它）。

- [ ] **Step 1: 写失败测试 `src/tools/websearch/index.test.ts`**

```typescript
import { describe, expect, it, vi } from 'vitest'
import { formatForLLM, resolveProvider, runWebSearch, setFetchOverride } from './index.js'
import type { WebSearchConfig } from '../../shared/types/config.js'
import type { WebSearchResponse } from './types.js'

const cfg = (provider: WebSearchConfig['provider'], keys?: { tavily?: string; brave?: string }): WebSearchConfig =>
  ({ provider, ...keys })

describe('resolveProvider', () => {
  it('auto falls back to duckduckgo when no keys', () => {
    expect(resolveProvider('auto', {}).id).toBe('duckduckgo')
  })

  it('auto prefers tavily when key present', () => {
    expect(resolveProvider('auto', { tavily: 't' }).id).toBe('tavily')
  })

  it('auto prefers brave over duckduckgo when brave key present (no tavily)', () => {
    expect(resolveProvider('auto', { brave: 'b' }).id).toBe('brave')
  })

  it('auto prefers tavily over brave when both present', () => {
    expect(resolveProvider('auto', { tavily: 't', brave: 'b' }).id).toBe('tavily')
  })

  it('explicit provider is honored even if key missing for duckduckgo', () => {
    expect(resolveProvider('duckduckgo', {}).id).toBe('duckduckgo')
  })

  it('explicit tavily without key throws', () => {
    expect(() => resolveProvider('tavily', {})).toThrow(/tavily/i)
  })

  it('explicit brave without key throws', () => {
    expect(() => resolveProvider('brave', {})).toThrow(/brave/i)
  })
})

describe('formatForLLM', () => {
  it('formats answer + numbered sources with truncated snippets', () => {
    const res: WebSearchResponse = {
      provider: 'tavily',
      answer: 'It is a language.',
      sources: [
        { title: 'A', url: 'https://a.example', snippet: 'short' },
        { title: 'B', url: 'https://b.example', snippet: 'x'.repeat(300) },
      ],
    }
    const out = formatForLLM(res)
    expect(out).toContain('It is a language.')
    expect(out).toContain('## Sources (2)')
    expect(out).toContain('[1] A')
    expect(out).toContain('https://a.example')
    expect(out).toContain('short')
    // snippet 截断到 240
    expect(out).toContain('[2] B')
    expect(out).not.toContain('x'.repeat(300))
  })

  it('omits Sources section when no sources', () => {
    const out = formatForLLM({ provider: 'duckduckgo', sources: [] })
    expect(out).not.toContain('## Sources')
  })

  it('omits snippet line when absent', () => {
    const out = formatForLLM({
      provider: 'duckduckgo',
      sources: [{ title: 'A', url: 'https://a.example' }],
    })
    expect(out).toContain('[1] A')
    expect(out).toContain('https://a.example')
    expect(out.split('\n').filter((l) => l.trim().startsWith('https')).length).toBe(1)
  })
})

describe('runWebSearch', () => {
  it('injects fetchImpl via module-level override (duckduckgo, mocked)', async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ AbstractText: 'ok', AbstractURL: 'https://x' }), {
        status: 200,
      }),
    ) as unknown as typeof fetch
    // runWebSearch 通过 setFetchOverride 注入测试 fetch（顶部已 import）
    setFetchOverride(f)
    try {
      const res = await runWebSearch(
        { query: 'typescript' },
        cfg('duckduckgo'),
        new AbortController().signal,
      )
      expect(res.provider).toBe('duckduckgo')
      expect(res.answer).toBe('ok')
    } finally {
      setFetchOverride(undefined)
    }
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run src/tools/websearch/index.test.ts`
Expected: FAIL — 模块不存在 / `WebSearchConfig` 未从 config.js 导出（Task 7 才定义）。

> **注意**：本测试 import 了 `../../shared/types/config.js` 的 `WebSearchConfig`。若 Task 7 未先执行，此测试会因类型缺失失败。**执行顺序**：先做 Task 7（config 类型），再做本 Task。两个 Task 解耦由执行者按依赖排序。

- [ ] **Step 3: 实现 `src/tools/websearch/index.ts`**

```typescript
import type { WebSearchConfig } from '../../shared/types/config.js'
import { braveProvider } from './providers/brave.js'
import { duckduckgoProvider } from './providers/duckduckgo.js'
import { tavilyProvider } from './providers/tavily.js'
import { createFetch } from './fetch.js'
import { DEFAULT_NUM_RESULTS, clampNumResults } from './types.js'
import type { Recency, WebSearchProvider, WebSearchProviderId, WebSearchResponse } from './types.js'

const PROVIDERS: Record<WebSearchProviderId, WebSearchProvider> = {
  duckduckgo: duckduckgoProvider,
  tavily: tavilyProvider,
  brave: braveProvider,
}

/** 环境变量名 → config key 字段映射。环境变量优先于 config。 */
function resolveKeys(config: WebSearchConfig): { tavily?: string; brave?: string } {
  return {
    tavily: process.env.TAVILY_API_KEY ?? config.tavilyApiKey,
    brave: process.env.BRAVE_API_KEY ?? config.braveApiKey,
  }
}

/** 按 preference + key 可用性解析目标 provider。auto 优先级：tavily > brave > duckduckgo。 */
export function resolveProvider(
  preference: 'auto' | WebSearchProviderId,
  keys: { tavily?: string; brave?: string },
): WebSearchProvider {
  if (preference === 'auto') {
    if (tavilyProvider.isAvailable(keys.tavily)) return tavilyProvider
    if (braveProvider.isAvailable(keys.brave)) return braveProvider
    return duckduckgoProvider
  }
  const provider = PROVIDERS[preference]
  if (!provider.isAvailable(preference === 'tavily' ? keys.tavily : keys.brave)) {
    throw new Error(`${preference} provider requires an API key (set ${preference === 'tavily' ? 'TAVILY_API_KEY' : 'BRAVE_API_KEY'} or config).`)
  }
  return provider
}

const SNIPPET_MAX = 240

/** 将统一响应格式化为 LLM 友好的纯文本。 */
export function formatForLLM(response: WebSearchResponse): string {
  const parts: string[] = []
  if (response.answer?.trim()) {
    parts.push(response.answer.trim())
  }
  if (response.sources.length > 0) {
    parts.push(`## Sources (${response.sources.length})`)
    for (const [i, src] of response.sources.entries()) {
      parts.push(`[${i + 1}] ${src.title}`)
      parts.push(`    ${src.url}`)
      if (src.snippet) parts.push(`    ${truncate(src.snippet, SNIPPET_MAX)}`)
    }
  }
  return parts.join('\n')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 模块级 fetch 覆盖（测试注入）。undefined 时用 createFetch()。 */
let fetchOverride: typeof fetch | undefined

/** 测试钩子：覆盖默认 fetch（undici ProxyAgent 包装版）。 */
export function setFetchOverride(f: typeof fetch | undefined): void {
  fetchOverride = f
}

function currentFetch(): typeof fetch {
  return fetchOverride ?? createFetch()
}

/** 工具入口：解析 provider → search → 返回 WebSearchResponse。 */
export async function runWebSearch(
  input: { query: string; numResults?: number; recency?: Recency },
  config: WebSearchConfig,
  abort: AbortSignal,
): Promise<WebSearchResponse> {
  const keys = resolveKeys(config)
  const provider = resolveProvider(config.provider, keys)
  return provider.search({
    query: input.query,
    limit: clampNumResults(input.numResults),
    recency: input.recency,
    signal: abort,
    apiKey: provider.id === 'tavily' ? keys.tavily : provider.id === 'brave' ? keys.brave : undefined,
    fetchImpl: currentFetch(),
  })
}

export { clampNumResults, DEFAULT_NUM_RESULTS }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run src/tools/websearch/index.test.ts`
Expected: PASS（resolveProvider 7 + formatForLLM 3 + runWebSearch 1 = 11/11）。

- [ ] **Step 5: 提交**

```bash
git add src/tools/websearch/index.ts src/tools/websearch/index.test.ts
git commit -m "feat(websearch): provider 注册表、选择与格式化"
```

---

## Task 7: Config 类型与默认值

**Files:**
- Modify: `src/shared/types/config.ts`（新增 WebSearchConfig 类型）
- Modify: `src/shared/types/config.test.ts`（断言默认值）
- Modify: `src/core/config.ts`（DEFAULT_CONFIG 加 websearch + tools.enabled 加 websearch）
- Modify: `src/core/config.test.ts`（断言 websearch 默认 + tools.enabled 含 websearch）

**执行顺序前置**：Task 6 依赖 `WebSearchConfig` 从 `config.js` 导出，故本 Task 应在 Task 6 之前完成。

- [ ] **Step 1: 先写测试 `src/shared/types/config.test.ts`（新增断言）**

读取现有文件，在末尾 describe 块内追加：

```typescript
  it('DEFAULT_CONFIG.websearch defaults to auto provider', () => {
    expect(DEFAULT_CONFIG.websearch.provider).toBe('auto')
    expect(DEFAULT_CONFIG.websearch.tavilyApiKey).toBeUndefined()
    expect(DEFAULT_CONFIG.websearch.braveApiKey).toBeUndefined()
  })
```

同步在 `src/core/config.test.ts` 末尾追加：

```typescript
  it('DEFAULT_CONFIG.tools.enabled includes websearch', () => {
    expect(DEFAULT_CONFIG.tools.enabled).toContain('websearch')
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run src/shared/types/config.test.ts src/core/config.test.ts`
Expected: FAIL — `websearch` 属性不存在 / tools.enabled 不含 websearch。

- [ ] **Step 3: 实现 `src/shared/types/config.ts`**

在文件 import 区之后、`Config` 类型之前新增：

```typescript
/** Web 搜索配置（spec websearch 设计文档）。 */
type WebSearchConfig = {
  /** 后端选择。'auto'（默认）→ 按 key 可用性：tavily > brave > duckduckgo。 */
  provider: 'auto' | 'duckduckgo' | 'tavily' | 'brave'
  /** Tavily key；也可由环境变量 TAVILY_API_KEY 提供（环境变量优先）。 */
  tavilyApiKey?: string
  /** Brave key；也可由环境变量 BRAVE_API_KEY 提供（环境变量优先）。 */
  braveApiKey?: string
}
```

在 `Config` 类型中新增字段：

```typescript
type Config = {
  // … 既有字段不变 …
  websearch: WebSearchConfig
}
```

在 `export type` 列表加入 `WebSearchConfig`。

- [ ] **Step 4: 实现 `src/core/config.ts`**

在 `DEFAULT_CONFIG` 对象中新增：

```typescript
const DEFAULT_CONFIG: Config = {
  // … 既有字段 …
  tools: { enabled: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'websearch'], disabled: [] },
  // … 其他既有字段 …
  websearch: { provider: 'auto' },
}
```

在 import 列表加入 `WebSearchConfig`：

```typescript
import type {
  CompactionConfig,
  Config,
  MCPServerConfig,
  SecurityConfig,
  ToolMetricsConfig,
  WebSearchConfig,
} from '../shared/types/config.js'
```

并在 export type 列表加入 `WebSearchConfig`。

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm vitest run src/shared/types/config.test.ts src/core/config.test.ts`
Expected: PASS。

- [ ] **Step 6: typecheck（确保无下游破坏）**

Run: `pnpm typecheck`
Expected: 0 errors。若有测试构造 `Config` 字面量缺 `websearch` 字段，补齐。

- [ ] **Step 7: 提交**

```bash
git add src/shared/types/config.ts src/shared/types/config.test.ts src/core/config.ts src/core/config.test.ts
git commit -m "feat(config): WebSearchConfig 类型与默认值，tools.enabled 含 websearch"
```

---

## Task 8: 工具定义（`src/tools/websearch/websearch.ts`）

**Files:**
- Create: `src/tools/websearch/websearch.ts`
- Test: `src/tools/websearch/websearch.test.ts`

- [ ] **Step 1: 写失败测试 `src/tools/websearch/websearch.test.ts`**

```typescript
import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
import type { WebSearchConfig } from '../../shared/types/config.js'
import { createWebSearchTool } from './websearch.js'
import { setFetchOverride } from './index.js'

function makeCtx(): ToolContext {
  return {
    cwd: '/tmp',
    session: { id: 's1', cwd: '/tmp' },
    abort: new AbortController().signal,
  }
}

const duckCfg: WebSearchConfig = { provider: 'duckduckgo' }

describe('createWebSearchTool', () => {
  it('defines name/description/permission=auto/timeout', () => {
    const tool = createWebSearchTool(duckCfg)
    expect(tool.name).toBe('websearch')
    expect(tool.permission).toBe('auto')
    expect(tool.timeout).toBe(30_000)
    expect(tool.description).toContain('web')
    expect(tool.parameters.required).toEqual(['query'])
  })

  it('returns formatted success output on results', async () => {
    const tool = createWebSearchTool(duckCfg)
    const f = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ AbstractText: 'TS', AbstractURL: 'https://ts.dev', Heading: 'TS' }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch
    setFetchOverride(f)
    try {
      const result = await tool.execute({ query: 'typescript' }, makeCtx())
      expect(result._tag).toBe('success')
      if (result._tag === 'success') {
        expect(result.output).toContain('TS')
        expect(result.output).toContain('https://ts.dev')
      }
    } finally {
      setFetchOverride(undefined)
    }
  })

  it('returns no-results message when sources empty and no answer', async () => {
    const tool = createWebSearchTool(duckCfg)
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
    setFetchOverride(f)
    try {
      const result = await tool.execute({ query: 'zzz' }, makeCtx())
      expect(result._tag).toBe('success')
      if (result._tag === 'success') {
        expect(result.output).toMatch(/no search results/i)
      }
    } finally {
      setFetchOverride(undefined)
    }
  })

  it('returns error on fetch failure', async () => {
    const tool = createWebSearchTool(duckCfg)
    const f = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    setFetchOverride(f)
    try {
      const result = await tool.execute({ query: 'x' }, makeCtx())
      expect(result._tag).toBe('error')
      if (result._tag === 'error') expect(result.error).toContain('network down')
    } finally {
      setFetchOverride(undefined)
    }
  })

  it('returns error when explicit provider lacks key', async () => {
    const tool = createWebSearchTool({ provider: 'tavily' })
    const result = await tool.execute({ query: 'x' }, makeCtx())
    expect(result._tag).toBe('error')
    if (result._tag === 'error') expect(result.error).toMatch(/tavily/i)
  })

  it('passes abort signal through', async () => {
    const tool = createWebSearchTool(duckCfg)
    const ac = new AbortController()
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
    setFetchOverride(f)
    try {
      const ctx = { ...makeCtx(), abort: ac.signal }
      await tool.execute({ query: 'x' }, ctx)
      const init = vi.mocked(f).mock.calls[0][1] as RequestInit
      expect(init.signal).toBe(ac.signal)
    } finally {
      setFetchOverride(undefined)
    }
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run src/tools/websearch/websearch.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 `src/tools/websearch/websearch.ts`**

```typescript
import type { WebSearchConfig } from '../../shared/types/config.js'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { formatForLLM, runWebSearch, setFetchOverride } from './index.js'

export { setFetchOverride }

const NO_RESULTS = 'No search results found. Try a different query.'

/**
 * websearch 工具工厂。config 由工厂闭包捕获（对齐 runSubAgent/debugSpawn 依赖反转模式）。
 * permission: auto（只读网络搜索，不改本地状态）。timeout 30s。
 */
export function createWebSearchTool(config: WebSearchConfig): ToolDef {
  return {
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
        numResults: {
          type: 'number',
          description: 'Number of results (default 8, max 20)',
        },
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
    execute: async (input, ctx): Promise<ToolResult> => {
      const { query, numResults, recency } = input as {
        query: string
        numResults?: number
        recency?: 'day' | 'week' | 'month' | 'year'
      }
      try {
        const response = await runWebSearch({ query, numResults, recency }, config, ctx.abort)
        if (!response.answer && response.sources.length === 0) {
          return { _tag: 'success', output: NO_RESULTS }
        }
        return { _tag: 'success', output: formatForLLM(response) }
      } catch (err) {
        return { _tag: 'error', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run src/tools/websearch/websearch.test.ts`
Expected: PASS（6/6）。

- [ ] **Step 5: 提交**

```bash
git add src/tools/websearch/websearch.ts src/tools/websearch/websearch.test.ts
git commit -m "feat(websearch): createWebSearchTool 工厂与 ToolDef"
```

---

## Task 9: 注册到默认 registry + 接线生产调用点

**Files:**
- Modify: `src/tools/index.ts`
- Modify: `src/tools/index.test.ts`
- Modify: `src/cli/deps.ts`
- Modify: `src/server/context.ts`
- Modify: `src/server/server.ts`

- [ ] **Step 1: 先写/改测试**

`src/tools/index.test.ts` — 在 `createDefaultRegistry registers all builtin tools` 用例中：

```typescript
  it('createDefaultRegistry registers all builtin tools', () => {
    const reg = createDefaultRegistry()
    const tools = listTools(reg)
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'bash',
      'debug_attach',
      'debug_breakpoints',
      'debug_continue',
      'debug_evaluate',
      'debug_launch',
      'debug_pause',
      'debug_stack_trace',
      'debug_step',
      'debug_threads',
      'debug_variables',
      'edit',
      'glob',
      'grep',
      'read',
      'task',
      'websearch',  // 新增
      'write',
    ])
  })
```

（执行者：以运行 `listTools(createDefaultRegistry()).map(t=>t.name).sort()` 的实际输出为准，仅需新增 `websearch`。）

再追加一用例验证 config 传入：

```typescript
  it('createDefaultRegistry(config) wires websearch with config', () => {
    const reg = createDefaultRegistry({ websearch: { provider: 'duckduckgo' } })
    const tool = getTool(reg, 'websearch')
    expect(tool).toBeDefined()
    expect(tool?.permission).toBe('auto')
  })

  it('createDefaultRegistry() without config still registers websearch (uses DEFAULT_CONFIG)', () => {
    const reg = createDefaultRegistry()
    expect(getTool(reg, 'websearch')).toBeDefined()
  })
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run src/tools/index.test.ts`
Expected: FAIL — websearch 不在 registry / createDefaultRegistry 不接收参数。

- [ ] **Step 3: 修改 `src/tools/index.ts`**

在 export 区新增：

```typescript
export { createWebSearchTool } from './websearch/websearch.js'
export { formatForLLM, resolveProvider, runWebSearch } from './websearch/index.js'
export type { WebSearchProvider, WebSearchProviderId, WebSearchSource, WebSearchResponse } from './websearch/types.js'
```

在 import 区（`createDefaultRegistry` 之前）加入：

```typescript
import { createWebSearchTool } from './websearch/websearch.js'
import { DEFAULT_CONFIG } from '../core/config.js'
```

> **循环依赖注意**：`core/config.js` 不依赖 `tools/index.js`，反向 import 安全。若 typecheck 报循环，改在 `createDefaultRegistry` 内部 lazy import。但实测 `core/config` 仅依赖 `shared/types`，无环。

修改 `createDefaultRegistry`：

```typescript
/**
 * Create a registry pre-loaded with all builtin tools:
 * read, write, edit, glob, grep, bash, task, websearch, and the debug_* set.
 *
 * @param config 可选配置；websearch 工具按 config.websearch 构造。省略时用 DEFAULT_CONFIG。
 */
export function createDefaultRegistry(config: Config = DEFAULT_CONFIG) {
  const reg = createToolRegistry()
  registerTool(reg, readTool)
  registerTool(reg, writeTool)
  registerTool(reg, editTool)
  registerTool(reg, globTool)
  registerTool(reg, grepTool)
  registerTool(reg, bashTool)
  registerTool(reg, taskTool)
  registerTool(reg, createWebSearchTool(config.websearch))
  for (const tool of dapTools) registerTool(reg, tool)
  return reg
}
```

并在顶部 import 加入 `Config` 类型：

```typescript
import type { Config } from '../shared/types/config.js'
```

- [ ] **Step 4: 接线生产调用点（传 config）**

`src/cli/deps.ts:54`：
```typescript
const toolRegistry = createDefaultRegistry(config)
```
（确认该函数作用域内已有 `config` 变量——见现有代码，`buildLLMRegistry(config)` 已在用。）

`src/server/context.ts:29`：
```typescript
toolRegistry: opts.toolRegistry ?? createDefaultRegistry(opts.config ?? DEFAULT_CONFIG),
```

`src/server/server.ts:110`：
```typescript
const toolRegistry = createDefaultRegistry(config)
```
（`config` 已由 `loadConfig(cwd)` 得到，在作用域内。）

- [ ] **Step 5: 运行测试，确认通过**

Run: `pnpm vitest run src/tools/index.test.ts`
Expected: PASS。

- [ ] **Step 6: typecheck 全量**

Run: `pnpm typecheck`
Expected: 0 errors。`createDefaultRegistry()` 现有 7 处无参调用（测试）仍合法（config 有默认值）。

- [ ] **Step 7: 提交**

```bash
git add src/tools/index.ts src/tools/index.test.ts src/cli/deps.ts src/server/context.ts src/server/server.ts
git commit -m "feat(websearch): 注册到默认 registry 并接线生产调用点"
```

---

## Task 10: 全量验证 + spec 文档更新

**Files:**
- Modify: `docs/superpowers/specs/2026-06-21-c0de-agent-design.md`（§5.1/§5.4 标注 websearch 已实现）

- [ ] **Step 1: 全量测试**

Run: `pnpm vitest run`
Expected: 全绿（含新增 websearch 子包测试 + 既有 154 files 不回归）。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 3: lint**

Run: `pnpm lint`
Expected: 0 errors。若 biome organizeImports 重排，确认 import 顺序合理。

- [ ] **Step 4: 更新主 spec**

`docs/superpowers/specs/2026-06-21-c0de-agent-design.md` §5.4 工具表 `websearch` 行：描述保留，在行尾或表后加注「✅ 已实现（见 `docs/superpowers/specs/2026-06-30-websearch-tool-design.md`）」。§5.1 文件结构中 `websearch.ts` 标注为子包已落地。

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/specs/2026-06-21-c0de-agent-design.md
git commit -m "docs(spec): 标注 websearch 工具已实现"
```

- [ ] **Step 6: 端到端 smoke（可选，需网络/代理）**

手动验证 DuckDuckGo 零 key 可用：

```bash
# 设置代理（若需要）
export HTTPS_PROXY=http://127.0.0.1:7890
# 通过 CLI/print 模式或 server 调用 websearch 工具
node --input-type=module -e "
import { createDefaultRegistry } from './src/tools/index.js'
import { getTool } from './src/tools/index.js'
const reg = createDefaultRegistry()
const tool = getTool(reg, 'websearch')
const res = await tool.execute({ query: 'TypeScript programming language' }, { cwd: process.cwd(), session: { id: 's1', cwd: process.cwd() }, abort: new AbortController().signal })
console.log(JSON.stringify(res, null, 2))
"
```
Expected: `{ "_tag": "success", "output": "<答案或来源列表>" }`。

---

## 验收标准（对照设计文档 §11）

1. ✅ `pnpm typecheck` 通过（Task 7-6、9 验证）
2. ✅ `pnpm lint` 通过（Task 10 Step 3）
3. ✅ `pnpm vitest run` 全绿，新增测试覆盖所有后端 + resolveProvider + formatForLLM + ToolDef（Task 1-9）
4. ✅ 工具注册到 `createDefaultRegistry`，LLM 可见 `websearch` schema（Task 9）
5. ✅ DuckDuckGo 后端零 key 可用（Task 10 Step 6 smoke）
6. ✅ 主 spec §5.1/§5.4 更新（Task 10 Step 4）

## 设计契约一致性

- `WebSearchProvider` 接口（`isAvailable` + `search`）— Task 1 定义，Task 3-5 实现，Task 6 注册表消费。✅
- `runWebSearch(input, config, abort)` 签名 — Task 6 定义，Task 8 调用。✅
- `createWebSearchTool(config)` 工厂 — Task 8 定义，Task 9 注册。✅
- `WebSearchConfig`（provider/tavilyApiKey/braveApiKey）— Task 7 定义，Task 6/8 消费。✅
- `setFetchOverride` 测试钩子 — Task 6 定义，Task 8 测试使用。✅
- 环境变量优先级（TAVILY_API_KEY/BRAVE_API_KEY > config）— Task 6 `resolveKeys` 实现。✅
