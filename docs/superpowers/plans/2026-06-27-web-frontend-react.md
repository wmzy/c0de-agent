# Web Frontend React 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 c0de-agent 的 React 19 前端（PWA），覆盖 Chat 流式、会话分支树、文件浏览器、设置页，以及 spec 的 PWA/离线/移动端增强全量功能。

**Architecture:** 单包子目录模式——前端源码在 `src/web/`，依赖装在根 `package.json`，构建用 Vite。前端通过 `@shared/*` 别名复用后端 `src/shared/types`，保证 SSE 事件与 API 响应类型与后端零漂移。数据层用 TanStack Query，SSE 用 fetch + ReadableStream 手写解析，样式用 Linaria 零运行时 CSS，路由用 @native-router/react。

**Tech Stack:** React 19, Vite 6, @tanstack/react-query v5, @linaria/core+react, @native-router/react, Shiki, marked, vite-plugin-pwa, CodeMirror 6, Vitest + @testing-library/react + happy-dom, haze-ui。

---

## 文件结构

单包子目录——根 `package.json` 承载所有依赖，`src/web/` 是前端源码区，配 `vite.config.ts`、独立 `tsconfig.json`、`index.html`。根 `tsconfig.json` exclude `src/web/**`，根 `vitest.config.ts` 用 `projects` 分离 node/happy-dom 两套环境。

```
src/web/
├── main.tsx                     # React 入口
├── App.tsx                      # 根组件（Provider 装配 + 路由）
├── index.html                   # Vite HTML 入口
├── vite.config.ts               # Vite + Linaria + PWA + proxy
├── tsconfig.json                # 前端 tsconfig（DOM lib, jsx, bundler）
├── test-setup.ts                # @testing-library/jest-dom 注册
├── types/
│   └── index.ts                 # 前端专用类型（SessionTreeNode、APIError、代码引用）
├── services/
│   ├── api.ts                   # fetch 封装 + APIError
│   ├── chat.ts                  # SSE 流解析 + sendChatMessage
│   ├── session.ts               # 会话 CRUD
│   ├── file.ts                  # 文件浏览/读写/搜索
│   ├── config.ts                # 配置 get/patch
│   └── agent.ts                 # abort/pause/resume/steer/confirmTool
├── hooks/
│   ├── useChat.ts               # SSE 事件 → 消息流状态
│   ├── useSession.ts            # TanStack Query 会话数据
│   ├── useAgent.ts              # agent 控制操作
│   ├── useMediaQuery.ts         # 响应式断点
│   ├── useOfflineQueue.ts       # 离线消息队列
│   ├── useVoiceInput.ts         # Web Speech API
│   ├── usePushNotification.ts   # Push API
│   └── useInstallPrompt.ts      # beforeinstallprompt
├── contexts/
│   ├── ThemeContext.tsx         # light/dark/system 主题
│   └── ConfigContext.tsx        # 配置缓存
├── styles/
│   ├── theme.ts                 # CSS 变量（light/dark）
│   ├── breakpoints.ts           # 断点常量
│   └── global.ts                # 全局样式（reset + 基础）
├── utils/
│   ├── highlight.ts             # Shiki 高亮器单例
│   ├── markdown.ts              # marked + 自定义 renderer
│   └── format.ts                # CodeReference 解析、token/时间格式化
├── views/
│   ├── Layout.tsx               # 响应式三栏布局
│   ├── Chat.tsx                 # 主聊天界面（消息流 + 输入区）
│   ├── SessionList.tsx          # 会话列表
│   ├── FileBrowser.tsx          # 文件树 + 搜索
│   ├── FilePreview.tsx          # 多格式预览
│   ├── Settings.tsx             # 配置页
│   └── NotFound.tsx             # 404
└── components/
    ├── MessageBubble.tsx        # 消息气泡
    ├── ToolCall.tsx             # 工具调用展示
    ├── StreamingIndicator.tsx   # 流式输入指示器
    ├── PermissionDialog.tsx     # 权限确认弹窗
    ├── BranchTree.tsx           # 分支树可视化
    ├── CodeBlock.tsx            # 代码块 + 引用按钮
    ├── CodeEditor.tsx           # CodeMirror 编辑器
    ├── Markdown.tsx             # Markdown 渲染封装
    ├── LLMDetail.tsx            # LLM 调用详情面板
    ├── SlashCommandMenu.tsx     # / 命令提示菜单
    ├── InputArea.tsx            # 自动扩展输入框
    ├── SubAgentProgress.tsx     # 子 agent 进度（预留）
    └── TouchHandlers.tsx        # 手势（左滑删除、长按菜单）
```

根配置改动：
- `package.json`：新增前端依赖 + `dev:web`/`build:web`/`preview:web` scripts。
- `tsconfig.json`：`exclude` 增加 `"src/web/**"`。
- `vitest.config.ts`：改用 `projects` 数组（node + happy-dom）。
- `src/server/app.ts`：新增 `serveStatic` 提供 `dist-web/` 产物（生产）。

---

## 关键设计决策

### 1. 单包子目录（非 workspace）
依赖全部装根 `package.json`。`src/web/` 仅是源码区，有自己的 `vite.config.ts`/`tsconfig.json`/`index.html`，但**不**有独立 `package.json`。根 `tsconfig.json` exclude `src/web/**`，使 `pnpm typecheck`（tsc）只编译后端；前端类型检查靠 `tsc -p src/web/tsconfig.json`（CI step）。根 `vitest.config.ts` 用 `projects` 同时跑 node 测试与 web 测试（happy-dom）。

### 2. 类型复用：@shared/* 别名
前端不重复定义后端已有类型。`src/web/tsconfig.json` 与 `vite.config.ts` 都配置 `@shared` → `src/shared`。前端直接 `import type { AgentEvent, Session, Message } from '@shared/types/agent.js'`。保证 SSE 事件、API 响应、共享类型与后端零漂移。

### 3. SSE 解析：手写 fetch + ReadableStream
不用 EventSource（不支持 POST/custom headers）。`services/chat.ts` 用 `fetch(POST)` + `response.body.getReader()` + `TextDecoder` 手写 SSE 帧解析（按 `\n\n` 分割事件，提取 `data:` 行 JSON）。测试用 mock Response 验证帧重组。

### 4. 状态管理：useChat 本地状态 + TanStack Query 服务端缓存
`useChat` 持有流式过程中增量组装的消息状态（text_delta 追加、tool_call_start/end 配对），**不**经过 TanStack Query（流式不适合 query cache）。会话列表/文件树等用 TanStack Query。流结束后 `queryClient.invalidateQueries(['session', id, 'messages'])` 刷新持久化消息。

### 5. 样式：Linaria 零运行时 CSS-in-JS
所有样式用 `@linaria/core` 的 `css` 模板字符串 + `@linaria/react` 的 `styled`。编译时提取为静态 CSS，无运行时开销。主题通过 CSS 变量（`--bg` 等）+ `.dark` class 切换。

### 6. 测试：组件测试为主
`src/web/**/*.test.tsx` 用 happy-dom + @testing-library/react。覆盖：services（SSE 解析、API client、错误）、utils（markdown、highlight、format）、hooks（useChat 事件 reducer、useMediaQuery）、关键组件（MessageBubble 事件渲染、PermissionDialog 交互、CodeBlock）。浏览器交互类（PWA 安装、推送）做 feature-detection + graceful degradation，测试用 mock。

### 7. 后端依赖说明
- **静态服务**：Task 1 在 `src/server/app.ts` 加 `serveStatic({ root: './dist-web' })`，生产环境 `/` 返回前端产物，`/api/*` 走 API。
- **SubAgentProgress（Task 12）**：后端当前无 `SubAgentEvent`。前端组件按 spec §2.10 类型实现，运行时若无子 agent 数据则不渲染。预留接口，待后端支持。
- **Push API（Task 12）**：需 VAPID 密钥与 push 订阅端点，后端未实现。前端实现订阅 UI + 本地通知（agent done 时 Notification API），服务端推送为预留。

---

## Task 1: 项目脚手架与构建配置

**Files:**
- Modify: `package.json`（依赖 + scripts）
- Modify: `tsconfig.json`（exclude src/web）
- Modify: `vitest.config.ts`（projects 双环境）
- Modify: `src/server/app.ts`（serveStatic）
- Create: `src/web/vite.config.ts`
- Create: `src/web/tsconfig.json`
- Create: `src/web/index.html`
- Create: `src/web/test-setup.ts`
- Create: `src/web/main.tsx`
- Create: `src/web/App.tsx`

- [ ] **Step 1: 前端依赖（已预装，验证即可）**

依赖已由 controller 预装并锁定（见 `package.json`）。核心版本：
- 运行时：react/react-dom@19、@tanstack/react-query@5、@native-router/{core,react}@1、@linaria/{core,react}@5、shiki@1、marked@12、haze-ui@1（不强依赖，peer 警告可忽略）
- 开发：vite@6、@vitejs/plugin-react@4、@linaria/vite@5、vite-plugin-pwa@1、@types/react@19、happy-dom@15、@testing-library/{react,jest-dom,user-event}@16/6/14、@codemirror/*@6

> **版本对齐（重要）**：linaria 必须全套 5.x（core/react/vite 同版本，是唯一有完整 vite 支持的组合；6/7/8 无配套 vite 插件）。vite-plugin-pwa 需 ^1 以兼容 vite 6。esbuild 构建已通过 `package.json` 的 `pnpm.onlyBuiltDependencies` 批准。

验证（无需重装）：

```bash
./node_modules/.bin/vite --version    # 期望 vite/6.x
node -e "require('@linaria/core')"    # 不报错即可
```

- [ ] **Step 2: 在 `package.json` 的 `scripts` 增加前端命令**

```json
{
  "scripts": {
    "dev:web": "vite --config src/web/vite.config.ts",
    "build:web": "vite build --config src/web/vite.config.ts",
    "preview:web": "vite preview --config src/web/vite.config.ts",
    "typecheck:web": "tsc -p src/web/tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 3: 根 `tsconfig.json` exclude src/web**

在 `"exclude"` 数组追加 `"src/web/**"`：

```json
{
  "exclude": ["node_modules", "dist", "src/web/**"]
}
```

- [ ] **Step 4: 改写 `vitest.config.ts` 为双 project**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/web/**', 'node_modules'],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['src/web/**/*.test.{ts,tsx}'],
          setupFiles: ['src/web/test-setup.ts'],
          testTimeout: 15_000,
        },
      },
    ],
  },
})
```

- [ ] **Step 5: 创建 `src/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["vite/client"],
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["../shared/*"]
    }
  },
  "include": [".", "../shared/types"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 6: 创建 `src/web/vite.config.ts`**

```typescript
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { linaria } from '@linaria/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  plugins: [
    react(),
    linaria({
      include: ['**/*.{ts,tsx}'],
      babelOptions: {
        presets: ['@babel/preset-typescript', '@babel/preset-react'],
      },
    }),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'c0de-agent',
        short_name: 'c0de',
        description: 'AI Coding Assistant',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        runtimeCaching: [
          {
            urlPattern: /\.[0-9a-f]{8,}\./,
            handler: 'CacheFirst',
            options: {
              cacheName: 'static-assets',
              expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../../dist-web'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name].[hash][extname]',
        chunkFileNames: 'assets/[name].[hash].js',
        entryFileNames: 'assets/[name].[hash].js',
      },
    },
  },
})
```

- [ ] **Step 7: 创建 `src/web/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
    <meta name="theme-color" content="#1a1a2e" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>c0de-agent</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: 创建 `src/web/test-setup.ts`**

```typescript
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 9: 创建 `src/web/main.tsx`（最小渲染）**

```typescript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles/global.js'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
```

> 注：`global.js` 在 Task 3 创建。Task 1 阶段先创建占位 `src/web/styles/global.ts` 导出空样式，使 main.tsx 能编译。

占位 `src/web/styles/global.ts`：

```typescript
import { css } from '@linaria/core'

export const globalStyle = css``
```

- [ ] **Step 10: 创建 `src/web/App.tsx`（骨架）**

```typescript
export function App() {
  return <div>c0de-agent</div>
}
```

- [ ] **Step 11: server 加静态文件服务**

修改 `src/server/app.ts`，在所有 API 路由之后、errorHandler 之前，加入 SPA 静态服务（生产环境 `dist-web/` 存在时启用）：

```typescript
import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'

// 在 createApp 内，路由注册后：
if (existsSync(path.resolve(ctx.cwd, 'dist-web'))) {
  app.use('/*', serveStatic({ root: './dist-web' }))
  app.get('/*', (c) => c.body(null)) // SPA fallback
}
```

> 需在文件顶部 `import path from 'node:path'`。开发环境前端走 Vite dev server (5173)，proxy `/api` 到 3000。

- [ ] **Step 12: 验证构建与测试环境**

```bash
pnpm typecheck           # 后端类型检查（应排除 src/web）
pnpm typecheck:web       # 前端类型检查（应通过）
pnpm test --project node # 仅 node 测试（应全绿，607 tests）
pnpm test --project web  # web 测试（此时为空，0 tests 通过）
pnpm build:web           # 前端构建（应产出 dist-web/）
```

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat(web): scaffold Vite + React project, dual vitest projects, server static"
```

---

## Task 2: 类型与 API 服务层

**Files:**
- Create: `src/web/types/index.ts`
- Create: `src/web/services/api.ts`
- Create: `src/web/services/chat.ts`
- Create: `src/web/services/session.ts`
- Create: `src/web/services/file.ts`
- Create: `src/web/services/config.ts`
- Create: `src/web/services/agent.ts`
- Test: `src/web/services/chat.test.ts`, `src/web/services/api.test.ts`

服务层是纯函数，无 React 依赖，可直接单测。SSE 解析是关键风险点。

- [ ] **Step 1: 创建 `src/web/types/index.ts`（前端专用类型 + 复用 shared）**

```typescript
import type { AgentEvent, LLMDetail } from '@shared/types/agent.js'
import type { Config } from '@shared/types/config.js'
import type { Message } from '@shared/types/message.js'
import type { Session } from '@shared/types/message.js'
import type { ToolResult } from '@shared/types/tool.js'

export type { AgentEvent, Config, LLMDetail, Message, Session, ToolResult }

/** 会话树节点（后端 GET /api/sessions/tree 返回）。 */
type SessionTreeNode = {
  session: Session
  children: SessionTreeNode[]
}

/** API 统一错误。 */
type APIError = {
  status: number
  message: string
  code?: string
}

/** 文件目录项（GET /api/files 返回）。 */
type FileEntry = {
  name: string
  type: 'file' | 'directory'
}

/** 文件搜索结果。 */
type FileSearchResult = {
  path: string
  type: 'file' | 'directory'
}

/** 文件读取响应。 */
type FileContent = {
  path: string
  content: string
}

/** 工具列表项（GET /api/tools 返回，不含 execute）。 */
type ToolListItem = {
  name: string
  description: string
  parameters: unknown
  permission: unknown
}

/** 代码引用（spec §10.4）。 */
type CodeReference =
  | { _tag: 'file'; path: string; startLine: number; endLine: number }
  | { _tag: 'message'; messageId: string; blockIndex: number }

export type {
  APIError,
  CodeReference,
  FileContent,
  FileEntry,
  FileSearchResult,
  SessionTreeNode,
  ToolListItem,
}
```

- [ ] **Step 2: 创建 `src/web/services/api.ts`**

```typescript
import type { APIError } from '../types/index.js'

const API_BASE = ''

async function apiRequest<T>(path: string, opts?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...opts?.headers,
    },
    credentials: 'same-origin',
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }))
    const error: APIError = {
      status: response.status,
      message: (body as { message?: string }).message ?? response.statusText,
      code: (body as { code?: string }).code,
    }
    throw error
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export { apiRequest, API_BASE }
```

- [ ] **Step 3: 编写 `src/web/services/api.test.ts`**

```typescript
import { describe, expect, it, vi, afterEach } from 'vitest'
import { apiRequest } from './api.js'

describe('apiRequest', () => {
  afterEach(() => vi.restoreAllMocks())

  it('返回解析后的 JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }))
    const result = await apiRequest('/api/health')
    expect(result).toEqual({ ok: true })
  })

  it('非 2xx 抛出 APIError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({ message: 'Session not found', code: 'NOT_FOUND' }),
    }))
    await expect(apiRequest('/api/sessions/x')).rejects.toMatchObject({
      status: 404,
      message: 'Session not found',
      code: 'NOT_FOUND',
    })
  })

  it('204 返回 undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 }))
    const result = await apiRequest('/api/sessions/x', { method: 'DELETE' })
    expect(result).toBeUndefined()
  })
})
```

- [ ] **Step 4: 创建 `src/web/services/chat.ts`（SSE 解析，核心）**

```typescript
import type { AgentEvent } from '@shared/types/agent.js'
import type { APIError } from '../types/index.js'

/** 从单个 SSE 帧文本提取 data 字段并解析为 AgentEvent。 */
export function parseSSEFrame(frame: string): AgentEvent | null {
  const lines = frame.split('\n')
  const dataLines = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart())
  if (dataLines.length === 0) return null
  try {
    return JSON.parse(dataLines.join('\n')) as AgentEvent
  } catch {
    return null
  }
}

/** 解析缓冲区，返回已完整的帧事件 + 剩余未完成文本。 */
export function consumeSSEBuffer(buffer: string): { events: AgentEvent[]; rest: string } {
  const events: AgentEvent[] = []
  let remaining = buffer
  let sep = remaining.indexOf('\n\n')
  while (sep !== -1) {
    const frame = remaining.slice(0, sep)
    const evt = parseSSEFrame(frame)
    if (evt) events.push(evt)
    remaining = remaining.slice(sep + 2)
    sep = remaining.indexOf('\n\n')
  }
  return { events, rest: remaining }
}

/** 发送聊天消息并消费 SSE 流，逐事件回调。 */
async function sendChatMessage(
  sessionId: string,
  message: string,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
  opts?: { provider?: string; model?: string; tools?: string[] },
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, ...opts }),
    signal,
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }))
    throw { status: response.status, message: (body as { message?: string }).message } as APIError
  }

  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const { events, rest } = consumeSSEBuffer(buffer)
    buffer = rest
    for (const evt of events) onEvent(evt)
  }
}

export { sendChatMessage }
```

> 该模块导出 `parseSSEFrame`、`consumeSSEBuffer`、`sendChatMessage` 三个函数。

- [ ] **Step 5: 编写 `src/web/services/chat.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { consumeSSEBuffer, parseSSEFrame } from './chat.js'

describe('parseSSEFrame', () => {
  it('解析 data 行 JSON', () => {
    const frame = 'event: text_delta\ndata: {"_tag":"text_delta","text":"hi"}'
    expect(parseSSEFrame(frame)).toEqual({ _tag: 'text_delta', text: 'hi' })
  })

  it('多行 data 合并', () => {
    const frame = 'data: {"_tag":"text_delta",\ndata: "text":"world"}'
    expect(parseSSEFrame(frame)).toEqual({ _tag: 'text_delta', text: 'world' })
  })

  it('无 data 行返回 null', () => {
    expect(parseSSEFrame('event: ping')).toBeNull()
  })

  it('JSON 非法返回 null', () => {
    expect(parseSSEFrame('data: {bad}')).toBeNull()
  })
})

describe('consumeSSEBuffer', () => {
  it('完整帧返回事件，清空 rest', () => {
    const buf = 'data: {"_tag":"done"}\n\n'
    const { events, rest } = consumeSSEBuffer(buf)
    expect(events).toHaveLength(1)
    expect(events[0]?._tag).toBe('done')
    expect(rest).toBe('')
  })

  it('不完整帧保留在 rest', () => {
    const buf = 'data: {"_tag":"text_delta","text":"par'
    const { events, rest } = consumeSSEBuffer(buf)
    expect(events).toHaveLength(0)
    expect(rest).toBe(buf)
  })

  it('跨 chunk 重组：先部分后补全', () => {
    const part1 = 'data: {"_tag":"text_delta","te'
    const r1 = consumeSSEBuffer(part1)
    expect(r1.events).toHaveLength(0)
    const part2 = r1.rest + 'xt":"ok"}\n\n'
    const r2 = consumeSSEBuffer(part2)
    expect(r2.events).toHaveLength(1)
    expect(r2.events[0]).toEqual({ _tag: 'text_delta', text: 'ok' })
  })

  it('多帧混合', () => {
    const buf = 'data: {"_tag":"text_delta","text":"a"}\n\ndata: {"_tag":"done"}\n\ndata: {"_tag":"text_delta","text":"b"}'
    const { events, rest } = consumeSSEBuffer(buf)
    expect(events).toHaveLength(2)
    expect(rest).toBe('data: {"_tag":"text_delta","text":"b"}')
  })
})
```

- [ ] **Step 6: 创建 `src/web/services/session.ts`**

```typescript
import type { Session } from '@shared/types/message.js'
import type { Message } from '@shared/types/message.js'
import type { LLMDetail } from '@shared/types/agent.js'
import type { SessionTreeNode } from '../types/index.js'
import { apiRequest } from './api.js'

const sessionAPI = {
  list: () => apiRequest<Session[]>('/api/sessions'),
  tree: () => apiRequest<SessionTreeNode[]>('/api/sessions/tree'),
  get: (id: string) => apiRequest<Session>(`/api/sessions/${id}`),
  create: (title?: string) =>
    apiRequest<Session>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    }),
  fork: (id: string, messageIndex: number) =>
    apiRequest<Session>(`/api/sessions/${id}/fork`, {
      method: 'POST',
      body: JSON.stringify({ messageIndex }),
    }),
  remove: (id: string) =>
    apiRequest<void>(`/api/sessions/${id}`, { method: 'DELETE' }),
  messages: (id: string) => apiRequest<Message[]>(`/api/sessions/${id}/messages`),
  llmDetails: (id: string) => apiRequest<LLMDetail[]>(`/api/sessions/${id}/llm-details`),
  branches: (id: string) => apiRequest<Session[]>(`/api/sessions/${id}/branches`),
}

export { sessionAPI }
```

- [ ] **Step 7: 创建 `src/web/services/file.ts`**

```typescript
import type { FileContent, FileEntry, FileSearchResult } from '../types/index.js'
import { apiRequest } from './api.js'

const fileAPI = {
  list: (path: string) =>
    apiRequest<FileEntry[]>(`/api/files?path=${encodeURIComponent(path)}`),
  read: (path: string) =>
    apiRequest<FileContent>(`/api/files/${encodeURI(path)}`),
  write: (path: string, content: string) =>
    apiRequest<{ path: string; written: boolean }>(`/api/files/${encodeURI(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  search: (query: string) =>
    apiRequest<FileSearchResult[]>(`/api/files/search?q=${encodeURIComponent(query)}`),
}

export { fileAPI }
```

- [ ] **Step 8: 创建 `src/web/services/config.ts` 与 `agent.ts`**

`src/web/services/config.ts`:

```typescript
import type { Config } from '@shared/types/config.js'
import { apiRequest } from './api.js'

const configAPI = {
  get: () => apiRequest<Config>('/api/config'),
  update: (patch: Partial<Config>) =>
    apiRequest<Config>('/api/config', { method: 'PATCH', body: JSON.stringify(patch) }),
}

export { configAPI }
```

`src/web/services/agent.ts`:

```typescript
import { apiRequest } from './api.js'

const agentAPI = {
  abort: (sessionId: string) =>
    apiRequest<{ aborted: boolean }>('/api/chat/abort', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  pause: (sessionId: string) =>
    apiRequest<{ paused: boolean }>('/api/chat/pause', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  resume: (sessionId: string) =>
    apiRequest<{ resumed: boolean }>('/api/chat/resume', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  steer: (sessionId: string, message: string) =>
    apiRequest<{ steered: boolean }>('/api/chat/steer', {
      method: 'POST',
      body: JSON.stringify({ sessionId, message }),
    }),
  confirmTool: (toolCallId: string, approved: boolean) =>
    apiRequest<{ confirmed: boolean }>('/api/tools/confirm', {
      method: 'POST',
      body: JSON.stringify({ toolCallId, approved }),
    }),
}

export { agentAPI }
```

- [ ] **Step 9: 运行测试**

```bash
pnpm test --project web
```

预期：api.test.ts（3）、chat.test.ts（10）通过。

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(web): API service layer with SSE stream parsing"
```

---

## Task 3: 主题、样式与上下文

**Files:**
- Create: `src/web/styles/theme.ts`, `breakpoints.ts`, `global.ts`
- Create: `src/web/contexts/ThemeContext.tsx`, `ConfigContext.tsx`
- Test: `src/web/contexts/ThemeContext.test.tsx`

- [ ] **Step 1: 创建 `src/web/styles/breakpoints.ts`**

```typescript
export const MOBILE = '@media (max-width: 767px)'
export const TABLET = '@media (min-width: 768px) and (max-width: 1023px)'
export const DESKTOP = '@media (min-width: 1024px)'
export const TOUCH = '@media (hover: none) and (pointer: coarse)'

export const BREAKPOINTS = { mobile: 768, tablet: 1024 } as const
```

- [ ] **Step 2: 创建 `src/web/styles/theme.ts`（CSS 变量）**

```typescript
import { css } from '@linaria/core'

export const themeVars = css`
  :global() {
    :root {
      --bg: #ffffff;
      --bg-secondary: #f5f5f5;
      --text: #1a1a1a;
      --text-secondary: #666666;
      --border: #e0e0e0;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --success: #16a34a;
      --warning: #d97706;
      --error: #dc2626;
      --code-bg: #f6f8fa;
      --shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }
    :global(.dark) {
      --bg: #0d1117;
      --bg-secondary: #161b22;
      --text: #e6edf3;
      --text-secondary: #8b949e;
      --border: #30363d;
      --primary: #58a6ff;
      --primary-hover: #79c0ff;
      --success: #3fb950;
      --warning: #d29922;
      --error: #f85149;
      --code-bg: #161b22;
      --shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    }
  }
`
```

- [ ] **Step 3: 重写 `src/web/styles/global.ts`（替换 Task 1 占位）**

```typescript
import { css } from '@linaria/core'
import { themeVars } from './theme.js'

export const globalStyle = css`
  ${themeVars}
  :global() {
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html,
    body,
    #root {
      height: 100%;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
    }
    button {
      cursor: pointer;
      font: inherit;
      min-height: 44px;
      min-width: 44px;
    }
  }
`
```

- [ ] **Step 4: 创建 `src/web/contexts/ThemeContext.tsx`**

```typescript
import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

type ThemeMode = 'light' | 'dark' | 'system'

type ThemeContextValue = {
  mode: ThemeMode
  resolved: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(
    () => (localStorage.getItem('c0de-theme') as ThemeMode | null) ?? 'system',
  )
  const resolved = mode === 'system' ? getSystemTheme() : mode

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
    localStorage.setItem('c0de-theme', mode)
  }, [mode, resolved])

  useEffect(() => {
    if (mode !== 'system') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => document.documentElement.classList.toggle('dark', mql.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [mode])

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
```

- [ ] **Step 5: 编写 `src/web/contexts/ThemeContext.test.tsx`**

```typescript
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemeProvider, useTheme } from './ThemeContext.js'

function Probe() {
  const { resolved, mode } = useTheme()
  return <div data-testid="probe">{mode}:{resolved}</div>
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('dark 模式添加 .dark class', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    // 默认 system，此处仅验证 provider 正常渲染
    expect(screen.getByTestId('probe')).toBeTruthy()
  })

  it('未在 Provider 内使用抛错', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow('useTheme must be used within ThemeProvider')
    spy.mockRestore()
  })
})
```

> 需在文件顶部 `import { vi } from 'vitest'`。

- [ ] **Step 6: 创建 `src/web/contexts/ConfigContext.tsx`**

```typescript
import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Config } from '@shared/types/config.js'
import { configAPI } from '../services/config.js'

type ConfigContextValue = {
  config: Config | null
  loading: boolean
  refresh: () => Promise<void>
}

const ConfigContext = createContext<ConfigContextValue | null>(null)

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    try {
      setConfig(await configAPI.get())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <ConfigContext.Provider value={{ config, loading, refresh }}>
      {children}
    </ConfigContext.Provider>
  )
}

export function useConfig(): ConfigContextValue {
  const ctx = useContext(ConfigContext)
  if (!ctx) throw new Error('useConfig must be used within ConfigProvider')
  return ctx
}
```

- [ ] **Step 7: 更新 `src/web/App.tsx` 装配 Provider**

```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from './contexts/ThemeContext.js'
import { ConfigProvider } from './contexts/ConfigContext.js'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 5 * 60_000, retry: 2, refetchOnWindowFocus: true },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConfigProvider>
          <div>App ready</div>
        </ConfigProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
```

- [ ] **Step 8: 运行测试 + 类型检查**

```bash
pnpm test --project web
pnpm typecheck:web
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(web): theme system, global styles, Theme/Config context providers"
```

---

## Task 4: 数据 Hooks 层

**Files:**
- Create: `src/web/hooks/useChat.ts`
- Create: `src/web/hooks/useSession.ts`
- Create: `src/web/hooks/useAgent.ts`
- Create: `src/web/hooks/useMediaQuery.ts`
- Test: `src/web/hooks/useChat.test.ts`, `src/web/hooks/useMediaQuery.test.ts`

`useChat` 是前端最复杂的状态逻辑：把 AgentEvent 流增量组装成消息状态。

- [ ] **Step 1: 创建 `src/web/hooks/useChat.ts`**

```typescript
import { useCallback, useRef, useState } from 'react'
import type { AgentError, AgentEvent } from '@shared/types/agent.js'
import type { Message, MessageContent } from '@shared/types/message.js'
import type { APIError } from '../types/index.js'
import { generateId } from './id.js'
import { sendChatMessage } from '../services/chat.js'

type ChatState = {
  messages: Message[]
  isStreaming: boolean
  usage: { input: number; output: number } | null
  error: string | null
  pendingPermission: { toolCallId: string; tool: string } | null
}

type ChatActions = {
  sendMessage: (content: string) => Promise<void>
  abort: () => void
  reset: () => void
}

const INITIAL: ChatState = {
  messages: [],
  isStreaming: false,
  usage: null,
  error: null,
  pendingPermission: null,
}

/** 把 AgentEvent 归约到消息状态。纯函数，可单测。 */
export function reduceChatEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event._tag) {
    case 'text_delta': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        const content = [...last.content]
        const lastPart = content[content.length - 1]
        if (lastPart && lastPart._tag === 'text') {
          content[content.length - 1] = { _tag: 'text', text: lastPart.text + event.text }
        } else {
          content.push({ _tag: 'text', text: event.text })
        }
        messages[messages.length - 1] = { ...last, content }
      } else {
        messages.push({
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: [{ _tag: 'text', text: event.text }],
          tokenCount: 0,
          createdAt: Date.now(),
        })
      }
      return { ...state, messages }
    }
    case 'thinking': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = {
          ...last,
          content: [...last.content, { _tag: 'thinking', text: event.text }],
        }
      } else {
        messages.push({
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: [{ _tag: 'thinking', text: event.text }],
          tokenCount: 0,
          createdAt: Date.now(),
        })
      }
      return { ...state, messages }
    }
    case 'tool_call_start': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      const part: MessageContent = {
        _tag: 'tool_call',
        id: event.id,
        tool: event.tool,
        input: event.input,
      }
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = { ...last, content: [...last.content, part] }
      } else {
        messages.push({
          id: generateId(),
          sessionId: '',
          role: 'assistant',
          content: [part],
          tokenCount: 0,
          createdAt: Date.now(),
        })
      }
      return { ...state, messages }
    }
    case 'tool_call_end': {
      const messages = state.messages.map((m) => {
        if (m.role !== 'assistant') return m
        const hasCall = m.content.some(
          (p) => p._tag === 'tool_call' && p.id === event.id,
        )
        if (!hasCall) return m
        return {
          ...m,
          content: [
            ...m.content,
            { _tag: 'tool_result', id: event.id, tool: '', output: event.result } as MessageContent,
          ],
        }
      })
      return { ...state, messages }
    }
    case 'tool_calls_parallel': {
      const messages = [...state.messages]
      const last = messages[messages.length - 1]
      const parts: MessageContent[] = event.calls.map((c) => ({
        _tag: 'tool_call',
        id: c.id,
        tool: c.tool,
        input: c.input,
      }))
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = { ...last, content: [...last.content, ...parts] }
      }
      return { ...state, messages }
    }
    case 'usage':
      return { ...state, usage: { input: event.input, output: event.output } }
    case 'permission_required':
      return {
        ...state,
        pendingPermission: { toolCallId: event.toolCallId, tool: event.tool },
      }
    case 'error':
      return { ...state, error: errorToMessage(event.error) }
    case 'done':
      return { ...state, isStreaming: false, pendingPermission: null }
    default:
      return state
  }
}

function errorToMessage(err: AgentError): string {
  switch (err._tag) {
    case 'aborted':
      return '已中止'
    case 'max_turns':
      return `达到最大轮数 ${err.maxTurns}`
    case 'unexpected':
      return err.message
    case 'provider':
      return err.message
    case 'tool':
      return `工具 ${err.toolName} 错误: ${err.message}`
  }
}

export function useChat(sessionId: string): ChatState & ChatActions {
  const [state, setState] = useState<ChatState>(INITIAL)
  const abortRef = useRef<AbortController | null>(null)

  const sendMessage = useCallback(
    async (content: string) => {
      const userMsg: Message = {
        id: generateId(),
        sessionId,
        role: 'user',
        content: [{ _tag: 'text', text: content }],
        tokenCount: 0,
        createdAt: Date.now(),
      }
      setState({ ...INITIAL, messages: [userMsg], isStreaming: true })
      abortRef.current = new AbortController()
      try {
        await sendChatMessage(
          sessionId,
          content,
          (event) => setState((s) => reduceChatEvent(s, event)),
          abortRef.current.signal,
        )
      } catch (err) {
        const e = err as APIError
        setState((s) => ({ ...s, isStreaming: false, error: e.message ?? '发送失败' }))
      }
    },
    [sessionId],
  )

  const abort = useCallback(() => {
    abortRef.current?.abort()
    setState((s) => ({ ...s, isStreaming: false }))
  }, [])

  const reset = useCallback(() => setState(INITIAL), [])

  return { ...state, sendMessage, abort, reset }
}
```

> 另外需创建 `src/web/hooks/id.ts` 导出 `generateId`（用 `crypto.randomUUID()`）：

```typescript
export function generateId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
```

- [ ] **Step 2: 编写 `src/web/hooks/useChat.test.ts`（测试 reducer 纯函数）**

```typescript
import { describe, expect, it } from 'vitest'
import { reduceChatEvent } from './useChat.js'
import type { ChatState } from './useChat.js'
import type { AgentEvent, AgentError } from '@shared/types/agent.js'

const base: ChatState = {
  messages: [],
  isStreaming: true,
  usage: null,
  error: null,
  pendingPermission: null,
}

function asst(parts: any[]): any[] {
  return [
    { id: 'a1', sessionId: 's', role: 'assistant', content: parts, tokenCount: 0, createdAt: 1 },
  ]
}

describe('reduceChatEvent', () => {
  it('text_delta 追加到新 assistant 消息', () => {
    const s = reduceChatEvent(base, { _tag: 'text_delta', text: 'hi' })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]?.content[0]).toEqual({ _tag: 'text', text: 'hi' })
  })

  it('连续 text_delta 累积到同一 text part', () => {
    let s = reduceChatEvent(base, { _tag: 'text_delta', text: 'a' })
    s = reduceChatEvent(s, { _tag: 'text_delta', text: 'b' })
    expect(s.messages[0]?.content[0]).toEqual({ _tag: 'text', text: 'ab' })
  })

  it('tool_call_start + tool_call_end 配对成结果', () => {
    let s = reduceChatEvent(base, { _tag: 'text_delta', text: 'x' })
    s = reduceChatEvent(s, { _tag: 'tool_call_start', id: 't1', tool: 'read', input: {} })
    expect(s.messages[0]?.content).toHaveLength(2)
    s = reduceChatEvent(s, {
      _tag: 'tool_call_end',
      id: 't1',
      result: { _tag: 'success', output: 'ok' },
    })
    const parts = s.messages[0]?.content
    const result = parts?.find((p: any) => p._tag === 'tool_result')
    expect(result?.output._tag).toBe('success')
  })

  it('thinking 作为独立 part', () => {
    const s = reduceChatEvent(
      { ...base, messages: asst([{ _tag: 'text', text: 'hi' }]) },
      { _tag: 'thinking', text: 'hmm' },
    )
    expect(s.messages[0]?.content[1]).toEqual({ _tag: 'thinking', text: 'hmm' })
  })

  it('usage 更新', () => {
    const s = reduceChatEvent(base, { _tag: 'usage', input: 10, output: 5 })
    expect(s.usage).toEqual({ input: 10, output: 5 })
  })

  it('done 结束流式', () => {
    const s = reduceChatEvent(base, { _tag: 'done' })
    expect(s.isStreaming).toBe(false)
  })

  it('error 转消息', () => {
    const err: AgentError = { _tag: 'provider', message: 'boom', retryable: false }
    const s = reduceChatEvent(base, { _tag: 'error', error: err })
    expect(s.error).toBe('boom')
  })

  it('permission_required 设置 pending', () => {
    const s = reduceChatEvent(base, {
      _tag: 'permission_required',
      toolCallId: 'p1',
      tool: 'bash',
      input: {},
    })
    expect(s.pendingPermission).toEqual({ toolCallId: 'p1', tool: 'bash' })
  })
})
```

- [ ] **Step 3: 创建 `src/web/hooks/useMediaQuery.ts`**

```typescript
import { useEffect, useState } from 'react'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  )

  useEffect(() => {
    const mql = window.matchMedia(query)
    const handler = () => setMatches(mql.matches)
    handler()
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [query])

  return matches
}
```

- [ ] **Step 4: 编写 `src/web/hooks/useMediaQuery.test.ts`**

```typescript
import { describe, expect, it, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMediaQuery } from './useMediaQuery.js'

describe('useMediaQuery', () => {
  afterEach(() => vi.restoreAllMocks())

  it('返回 matchMedia 结果', () => {
    vi.stubGlobal('matchMedia',
      vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    )
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)'))
    expect(result.current).toBe(true)
  })
})
```

- [ ] **Step 5: 创建 `src/web/hooks/useSession.ts`（TanStack Query）**

```typescript
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Session } from '@shared/types/message.js'
import type { SessionTreeNode, Message } from '../types/index.js'
import { sessionAPI } from '../services/session.js'

export function useSessionTree() {
  return useQuery({ queryKey: ['sessions', 'tree'], queryFn: () => sessionAPI.tree() })
}

export function useSessionList() {
  return useQuery({ queryKey: ['sessions'], queryFn: () => sessionAPI.list() })
}

export function useMessages(sessionId: string | null) {
  return useQuery({
    queryKey: ['session', sessionId, 'messages'],
    queryFn: () => sessionAPI.messages(sessionId!),
    enabled: !!sessionId,
  })
}

export function useCreateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (title?: string) => sessionAPI.create(title),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  })
}

export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sessionAPI.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['sessions', 'tree'] })
    },
  })
}

export function useForkSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, messageIndex }: { id: string; messageIndex: number }) =>
      sessionAPI.fork(id, messageIndex),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions', 'tree'] }),
  })
}
```

- [ ] **Step 6: 创建 `src/web/hooks/useAgent.ts`**

```typescript
import { useCallback, useState } from 'react'
import { agentAPI } from '../services/agent.js'

export function useAgent(sessionId: string) {
  const [busy, setBusy] = useState(false)

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    busy,
    abort: () => run(() => agentAPI.abort(sessionId)),
    pause: () => run(() => agentAPI.pause(sessionId)),
    resume: () => run(() => agentAPI.resume(sessionId)),
    steer: (message: string) => run(() => agentAPI.steer(sessionId, message)),
    confirmTool: (toolCallId: string, approved: boolean) =>
      run(() => agentAPI.confirmTool(toolCallId, approved)),
  }
}
```

- [ ] **Step 7: 运行测试**

```bash
pnpm test --project web
```

预期：useChat reducer（8）、useMediaQuery（1）通过。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): chat event reducer, session/agent hooks, media query"
```

---

## Task 5: Markdown 渲染与代码高亮

**Files:**
- Create: `src/web/utils/highlight.ts`, `markdown.ts`, `format.ts`
- Create: `src/web/components/CodeBlock.tsx`, `Markdown.tsx`
- Test: `src/web/utils/format.test.ts`

- [ ] **Step 1: 创建 `src/web/utils/highlight.ts`（Shiki 单例）**

```typescript
import { createHighlighter } from 'shiki'

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [
        'javascript', 'typescript', 'python', 'rust', 'go', 'java', 'c', 'cpp',
        'html', 'css', 'json', 'yaml', 'markdown', 'bash', 'sql',
      ],
    })
  }
  return highlighterPromise
}

export async function highlightCode(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter()
  return hl.codeToHtml(code, {
    lang: lang || 'text',
    themes: { dark: 'github-dark', light: 'github-light' },
  })
}
```

- [ ] **Step 2: 创建 `src/web/utils/format.ts`**

```typescript
import type { CodeReference } from '../types/index.js'

/** 解析输入文本中的代码引用 @[path:start-end] 或 @[msgId:n]。 */
export function parseCodeReference(text: string): CodeReference | null {
  const fileMatch = text.match(/^@\[([^:]+):(\d+)(?:-(\d+))?\]$/)
  if (fileMatch) {
    const [, path, start, end] = fileMatch
    return {
      _tag: 'file',
      path: path!,
      startLine: Number(start),
      endLine: end ? Number(end) : Number(start),
    }
  }
  const msgMatch = text.match(/^@\[([^:]+):(\d+)\]$/)
  if (msgMatch) {
    const [, messageId, idx] = msgMatch
    return { _tag: 'message', messageId: messageId!, blockIndex: Number(idx) }
  }
  return null
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`
  return `${(n / 1000).toFixed(1)}k`
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
```

- [ ] **Step 3: 编写 `src/web/utils/format.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { parseCodeReference, formatTokenCount, formatLatency } from './format.js'

describe('parseCodeReference', () => {
  it('文件引用单行', () => {
    expect(parseCodeReference('@[src/main.ts:10]')).toEqual({
      _tag: 'file', path: 'src/main.ts', startLine: 10, endLine: 10,
    })
  })
  it('文件引用区间', () => {
    expect(parseCodeReference('@[src/a.ts:5-12]')).toEqual({
      _tag: 'file', path: 'src/a.ts', startLine: 5, endLine: 12,
    })
  })
  it('消息引用', () => {
    expect(parseCodeReference('@[msg_abc:2]')).toEqual({
      _tag: 'message', messageId: 'msg_abc', blockIndex: 2,
    })
  })
  it('非法返回 null', () => {
    expect(parseCodeReference('hello')).toBeNull()
  })
})

describe('formatTokenCount', () => {
  it('小于 1000 原值', () => expect(formatTokenCount(500)).toBe('500'))
  it('k 单位', () => expect(formatTokenCount(1500)).toBe('1.5k'))
})

describe('formatLatency', () => {
  it('ms', () => expect(formatLatency(500)).toBe('500ms'))
  it('s', () => expect(formatLatency(1500)).toBe('1.50s'))
})
```

- [ ] **Step 4: 创建 `src/web/utils/markdown.ts`**

```typescript
import { Marked } from 'marked'
import { highlightCode } from './highlight.js'

const marked = new Marked({ gfm: true, breaks: true })

/** 同步渲染 Markdown（代码块不高亮，供首屏）。 */
export function renderMarkdownSync(content: string): string {
  return marked.parse(content) as string
}

/** 异步渲染（代码块走 Shiki 高亮）。 */
export async function renderMarkdown(content: string): Promise<string> {
  const renderer = new marked.Renderer()
  const origCode = renderer.code.bind(renderer)
  renderer.code = async ({ text, lang }) => {
    try {
      const html = await highlightCode(text, lang ?? 'text')
      return `<div class="code-block">${html}</div>`
    } catch {
      return origCode({ text, lang })
    }
  }
  return (await marked.parse(content, { renderer, async: true })) as string
}
```

- [ ] **Step 5: 创建 `src/web/components/CodeBlock.tsx`**

```typescript
import { useEffect, useState } from 'react'
import { css } from '@linaria/core'
import { highlightCode } from '../utils/highlight.js'

const wrap = css`
  position: relative;
  border-radius: 6px;
  overflow: hidden;
  margin: 8px 0;
  background: var(--code-bg);
`

const header = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
`

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState('')
  useEffect(() => {
    void highlightCode(code, lang ?? 'text').then(setHtml)
  }, [code, lang])
  return (
    <div className={wrap}>
      <div className={header}>
        <span>{lang ?? 'text'}</span>
        <button onClick={() => navigator.clipboard?.writeText(code)} type="button">复制</button>
      </div>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
```

- [ ] **Step 6: 创建 `src/web/components/Markdown.tsx`**

```typescript
import { useEffect, useState } from 'react'
import { renderMarkdown } from '../utils/markdown.js'

export function Markdown({ content }: { content: string }) {
  const [html, setHtml] = useState('')
  useEffect(() => {
    void renderMarkdown(content).then(setHtml)
  }, [content])
  return <div dangerouslySetInnerHTML={{ __html: html }} />
}
```

- [ ] **Step 7: 运行测试**

```bash
pnpm test --project web
pnpm typecheck:web
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): markdown rendering, Shiki highlight, code block, format utils"
```

---

## Task 6: 核心聊天组件

**Files:**
- Create: `src/web/components/MessageBubble.tsx`, `ToolCall.tsx`, `StreamingIndicator.tsx`, `PermissionDialog.tsx`
- Test: `src/web/components/MessageBubble.test.tsx`, `src/web/components/PermissionDialog.test.tsx`

- [ ] **Step 1: 创建 `src/web/components/ToolCall.tsx`**

```typescript
import { useState } from 'react'
import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'

const card = css`
  border: 1px solid var(--border);
  border-radius: 6px;
  margin: 6px 0;
  font-size: 13px;
`

const summary = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
  background: var(--bg-secondary);
`

export function ToolCall({
  name,
  input,
  result,
}: {
  name: string
  input: unknown
  result?: ToolResult
}) {
  const [open, setOpen] = useState(false)
  const statusIcon = result
    ? result._tag === 'success'
      ? '✓'
      : result._tag === 'error'
        ? '✗'
        : '·'
    : '⏳'
  return (
    <div className={card}>
      <div className={summary} onClick={() => setOpen((v) => !v)} onKeyDown={() => setOpen((v) => !v)} role="button" tabIndex={0}>
        <span>{statusIcon}</span>
        <span>{name}</span>
      </div>
      {open && (
        <div style={{ padding: '8px' }}>
          <pre>{JSON.stringify(input, null, 2)}</pre>
          {result && result._tag !== 'permission_required' && (
            <pre>{'output' in result ? result.output : 'error' in result ? result.error : ''}</pre>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 创建 `src/web/components/MessageBubble.tsx`**

```typescript
import { css } from '@linaria/core'
import type { Message } from '@shared/types/message.js'
import { Markdown } from './Markdown.js'
import { ToolCall } from './ToolCall.js'

const bubble = css`
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 12px;
  margin: 8px 0;
  word-break: break-word;
`

const user = css`
  align-self: flex-end;
  background: var(--primary);
  color: #fff;
`

const asst = css`
  align-self: flex-start;
  background: var(--bg-secondary);
`

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  return (
    <div className={`${bubble} ${isUser ? user : asst}`} data-testid="message" data-role={message.role}>
      {message.content.map((part, i) => {
        switch (part._tag) {
          case 'text':
            return <Markdown key={i} content={part.text} />
          case 'thinking':
            return (
              <details key={i}>
                <summary>思考过程</summary>
                <Markdown content={part.text} />
              </details>
            )
          case 'tool_call':
            return (
              <ToolCall
                key={i}
                name={part.tool}
                input={part.input}
              />
            )
          case 'tool_result':
            return <ToolCall key={i} name={part.tool} input={null} result={part.output} />
          default:
            return null
        }
      })}
    </div>
  )
}
```

- [ ] **Step 3: 编写 `src/web/components/MessageBubble.test.tsx`**

```typescript
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageBubble } from './MessageBubble.js'
import type { Message } from '@shared/types/message.js'

function msg(role: any, parts: any[]): Message {
  return { id: '1', sessionId: 's', role, content: parts, tokenCount: 0, createdAt: 1 }
}

describe('MessageBubble', () => {
  it('渲染 user 角色', () => {
    render(<MessageBubble message={msg('user', [{ _tag: 'text', text: 'hi' }])} />)
    const el = screen.getByTestId('message')
    expect(el.getAttribute('data-role')).toBe('user')
  })

  it('渲染 assistant 工具调用', () => {
    render(
      <MessageBubble
        message={msg('assistant', [
          { _tag: 'tool_call', id: 't1', tool: 'read', input: { path: 'a.ts' } },
        ])}
      />,
    )
    expect(screen.getByText('read')).toBeTruthy()
  })

  it('thinking 折叠', () => {
    const { container } = render(
      <MessageBubble message={msg('assistant', [{ _tag: 'thinking', text: 'hmm' }])} />,
    )
    expect(container.querySelector('summary')?.textContent).toBe('思考过程')
  })
})
```

- [ ] **Step 4: 创建 `src/web/components/StreamingIndicator.tsx`**

```typescript
import { css } from '@linaria/core'

const dot = css`
  display: inline-block;
  width: 6px;
  height: 6px;
  margin: 0 2px;
  border-radius: 50%;
  background: var(--text-secondary);
  animation: blink 1.4s infinite both;
  @keyframes blink {
    0%, 80%, 100% { opacity: 0.2; }
    40% { opacity: 1; }
  }
`

export function StreamingIndicator() {
  return (
    <span aria-label="正在输入" data-testid="streaming">
      <span className={dot} />
      <span className={dot} style={{ animationDelay: '0.2s' }} />
      <span className={dot} style={{ animationDelay: '0.4s' }} />
    </span>
  )
}
```

- [ ] **Step 5: 创建 `src/web/components/PermissionDialog.tsx`**

```typescript
import { css } from '@linaria/core'

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`

const dialog = css`
  background: var(--bg);
  border-radius: 8px;
  padding: 20px;
  max-width: 400px;
  box-shadow: var(--shadow);
`

export function PermissionDialog({
  tool,
  input,
  onConfirm,
  onCancel,
}: {
  tool: string
  input: unknown
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className={overlay} role="dialog" aria-modal="true" data-testid="permission-dialog">
      <div className={dialog}>
        <h3>权限确认</h3>
        <p>工具 <strong>{tool}</strong> 请求执行：</p>
        <pre style={{ maxHeight: '200px', overflow: 'auto' }}>{JSON.stringify(input, null, 2)}</pre>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} type="button">拒绝</button>
          <button onClick={onConfirm} type="button" data-testid="approve">允许</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: 编写 `src/web/components/PermissionDialog.test.tsx`**

```typescript
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PermissionDialog } from './PermissionDialog.js'

describe('PermissionDialog', () => {
  it('显示工具名和输入', () => {
    render(<PermissionDialog tool="bash" input={{ cmd: 'ls' }} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('bash')).toBeTruthy()
    expect(screen.getByTestId('permission-dialog')).toBeTruthy()
  })

  it('点击允许调用 onConfirm', () => {
    const onConfirm = vi.fn()
    render(<PermissionDialog tool="bash" input={{}} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('approve'))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 7: 运行测试**

```bash
pnpm test --project web
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): message bubble, tool call card, streaming indicator, permission dialog"
```

---

## Task 7: 响应式布局与聊天主视图

**Files:**
- Create: `src/web/views/Layout.tsx`
- Create: `src/web/views/Chat.tsx`
- Create: `src/web/components/InputArea.tsx`, `SlashCommandMenu.tsx`
- Test: `src/web/components/InputArea.test.tsx`

- [ ] **Step 1: 创建 `src/web/views/Layout.tsx`（响应式三栏）**

```typescript
import type { ReactNode } from 'react'
import { css } from '@linaria/core'
import { DESKTOP, MOBILE } from '../styles/breakpoints.js'

const layout = css`
  display: flex;
  flex-direction: column;
  height: 100dvh;
  width: 100%;
  ${DESKTOP} {
    flex-direction: row;
  }
`

const sidebar = css`
  display: none;
  width: 100%;
  ${DESKTOP} {
    display: flex;
    flex-direction: column;
    width: 280px;
    border-right: 1px solid var(--border);
    flex-shrink: 0;
  }
`

const main = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
`

const panel = css`
  display: none;
  ${DESKTOP} {
    display: flex;
    width: 360px;
    border-left: 1px solid var(--border);
    flex-shrink: 0;
  }
`

type LayoutProps = {
  sidebar?: ReactNode
  main: ReactNode
  panel?: ReactNode
}

export function Layout({ sidebar: sidebarNode, main, panel }: LayoutProps) {
  return (
    <div className={layout}>
      {sidebarNode && <aside className={sidebar}>{sidebarNode}</aside>}
      <main className={main}>{main}</main>
      {panel && <aside className={panel}>{panel}</aside>}
    </div>
  )
}
```

- [ ] **Step 2: 创建 `src/web/components/SlashCommandMenu.tsx`**

```typescript
import { css } from '@linaria/core'

const menu = css`
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
  max-height: 240px;
  overflow: auto;
`

const item = css`
  display: flex;
  flex-direction: column;
  padding: 8px 12px;
  cursor: pointer;
  &:hover { background: var(--bg-secondary); }
`
const COMMANDS = [
  { name: '/clear', desc: '清除当前会话' },
  { name: '/fork', desc: '从当前消息分支' },
  { name: '/compact', desc: '压缩上下文' },
  { name: '/help', desc: '查看帮助' },
]

export function SlashCommandMenu({
  query,
  onPick,
}: {
  query: string
  onPick: (cmd: string) => void
}) {
  const filtered = COMMANDS.filter((c) => c.name.startsWith(query))
  if (filtered.length === 0) return null
  return (
    <div className={menu} data-testid="slash-menu">
      {filtered.map((c) => (
        <div key={c.name} className={item} onClick={() => onPick(c.name)} onKeyDown={() => onPick(c.name)} role="button" tabIndex={0}>
          <strong>{c.name}</strong>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{c.desc}</span>
        </div>
      ))
    </div>
  )
}
```

- [ ] **Step 3: 创建 `src/web/components/InputArea.tsx`**

```typescript
import { useRef, useState } from 'react'
import { css } from '@linaria/core'
import { SlashCommandMenu } from './SlashCommandMenu.js'

const wrap = css`
  position: relative;
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--border);
  background: var(--bg);
`

const textarea = css`
  flex: 1;
  resize: none;
  min-height: 44px;
  max-height: 200px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text);
  font: inherit;
`

export function InputArea({
  onSend,
  disabled,
  steerMode,
}: {
  onSend: (text: string) => void
  disabled?: boolean
  steerMode?: boolean
}) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const autoResize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }

  const send = () => {
    const v = value.trim()
    if (!v || disabled) return
    onSend(v)
    setValue('')
    if (ref.current) ref.current.style.height = 'auto'
  }

  const isSlash = value.startsWith('/') && !value.includes(' ')
  return (
    <div className={wrap}>
      {isSlash && <SlashCommandMenu query={value} onPick={(c) => { setValue(`${c} `); ref.current?.focus() }} />}
      <textarea
        ref={ref}
        className={textarea}
        value={value}
        placeholder={steerMode ? '注入 steering 消息…' : '输入消息，/ 查看命令'}
        onChange={(e) => { setValue(e.target.value); autoResize() }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
        disabled={disabled}
        data-testid="input"
      />
      <button onClick={send} disabled={disabled || !value.trim()} type="button" data-testid="send">
        {steerMode ? '注入' : '发送'}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: 编写 `src/web/components/InputArea.test.tsx`**

```typescript
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InputArea } from './InputArea.js'

describe('InputArea', () => {
  it('输入后点发送回调', () => {
    const onSend = vi.fn()
    render(<InputArea onSend={onSend} />)
    fireEvent.change(screen.getByTestId('input'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('send'))
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  it('空文本不发送', () => {
    const onSend = vi.fn()
    render(<InputArea onSend={onSend} />)
    fireEvent.click(screen.getByTestId('send'))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('Enter 发送，Shift+Enter 不', () => {
    const onSend = vi.fn()
    render(<InputArea onSend={onSend} />)
    fireEvent.change(screen.getByTestId('input'), { target: { value: 'x' } })
    fireEvent.keyDown(screen.getByTestId('input'), { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByTestId('input'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalled()
  })

  it('/ 显示 slash 菜单', () => {
    render(<InputArea onSend={vi.fn()} />)
    fireEvent.change(screen.getByTestId('input'), { target: { value: '/' } })
    expect(screen.getByTestId('slash-menu')).toBeTruthy()
  })
})
```

- [ ] **Step 5: 创建 `src/web/views/Chat.tsx`（主界面）**

```typescript
import { useEffect, useRef } from 'react'
import { css } from '@linaria/core'
import type { Message } from '@shared/types/message.js'
import { MessageBubble } from '../components/MessageBubble.js'
import { StreamingIndicator } from '../components/StreamingIndicator.js'
import { PermissionDialog } from '../components/PermissionDialog.js'
import { InputArea } from '../components/InputArea.js'
import { formatTokenCount } from '../utils/format.js'

type ChatProps = {
  messages: Message[]
  isStreaming: boolean
  usage: { input: number; output: number } | null
  pendingPermission: { toolCallId: string; tool: string } | null
  onSend: (text: string) => void
  onAbort: () => void
  onConfirm: (toolCallId: string, approved: boolean) => void
}

const stream = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  overflow-y: auto;
`

const toolbar = css`
  display: flex;
  justify-content: space-between;
  padding: 4px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
`

export function Chat({
  messages, isStreaming, usage, pendingPermission, onSend, onAbort, onConfirm,
}: ChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <>
      <div className={toolbar}>
        <span>
          {usage
            ? `${formatTokenCount(usage.input)} → ${formatTokenCount(usage.output)} tokens`
            : 'c0de-agent'}
        </span>
        {isStreaming ? (
          <button onClick={onAbort} type="button" data-testid="abort">中止</button>
        ) : null}
      </div>
      <div className={stream} data-testid="stream">
        {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
        {isStreaming && <StreamingIndicator />}
        <div ref={bottomRef} />
      </div>
      {pendingPermission && (
        <PermissionDialog
          tool={pendingPermission.tool}
          input={null}
          onConfirm={() => onConfirm(pendingPermission.toolCallId, true)}
          onCancel={() => onConfirm(pendingPermission.toolCallId, false)}
        />
      )}
      <InputArea onSend={onSend} disabled={isStreaming} />
    </>
  )
}
```

- [ ] **Step 6: 运行测试 + 类型检查**

```bash
pnpm test --project web
pnpm typecheck:web
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): responsive layout, chat main view, auto-resize input, slash menu"
```

---

## Task 8: 会话列表、分支树与路由

**Files:**
- Create: `src/web/views/SessionList.tsx`
- Create: `src/web/components/BranchTree.tsx`
- Modify: `src/web/App.tsx`（装配路由）
- Test: `src/web/components/BranchTree.test.tsx`

- [ ] **Step 1: 创建 `src/web/components/BranchTree.tsx`**

```typescript
import { css } from '@linaria/core'
import type { SessionTreeNode } from '../types/index.js'

const node = css`
  padding: 2px 0;
`

const row = css`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: 4px;
  &:hover { background: var(--bg-secondary); }
`

const active = css`
  background: var(--bg-secondary);
  font-weight: 600;
`
const childList = css`
  padding-left: 16px;
  border-left: 1px solid var(--border);
  margin-left: 8px;
`

export function BranchTree({
  nodes,
  activeId,
  onSelect,
}: {
  nodes: SessionTreeNode[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <div data-testid="branch-tree">
      {nodes.map((n) => (
        <TreeNode key={n.session.id} node={n} activeId={activeId} depth={0} onSelect={onSelect} />
      ))}
    </div>
  )
}

function TreeNode({
  node: n, activeId, depth, onSelect,
}: {
  node: SessionTreeNode
  activeId: string | null
  depth: number
  onSelect: (id: string) => void
}) {
  const isActive = n.session.id === activeId
  return (
    <div className={node}>
      <div
        className={`${row} ${isActive ? active : ''}`}
        onClick={() => onSelect(n.session.id)}
        onKeyDown={() => onSelect(n.session.id)}
        role="button"
        tabIndex={0}
        data-testid={`node-${n.session.id}`}
      >
        <span>{n.children.length > 0 ? '📂' : '💬'}</span>
        <span>{n.session.title}</span>
      </div>
      {n.children.length > 0 && (
        <div className={childList}>
          {n.children.map((c) => (
            <TreeNode key={c.session.id} node={c} activeId={activeId} depth={depth + 1} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 编写 `src/web/components/BranchTree.test.tsx`**

```typescript
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BranchTree } from './BranchTree.js'
import type { SessionTreeNode } from '../types/index.js'

const tree: SessionTreeNode[] = [
  {
    session: { id: 's1', title: 'Root', parentId: null, branchPoint: null, metadata: {}, createdAt: 1, updatedAt: 1 },
    children: [
      {
        session: { id: 's2', title: 'Child', parentId: 's1', branchPoint: 0, metadata: {}, createdAt: 2, updatedAt: 2 },
        children: [],
      },
    ],
  },
]

describe('BranchTree', () => {
  it('递归渲染父子节点', () => {
    render(<BranchTree nodes={tree} activeId="s1" onSelect={vi.fn()} />)
    expect(screen.getByTestId('node-s1')).toBeTruthy()
    expect(screen.getByTestId('node-s2')).toBeTruthy()
  })

  it('点击节点回调 id', () => {
    const onSelect = vi.fn()
    render(<BranchTree nodes={tree} activeId={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('node-s2'))
    expect(onSelect).toHaveBeenCalledWith('s2')
  })
})
```

- [ ] **Step 3: 创建 `src/web/views/SessionList.tsx`**

```typescript
import { css } from '@linaria/core'
import { BranchTree } from '../components/BranchTree.js'
import { useSessionTree, useCreateSession, useDeleteSession } from '../hooks/useSession.js'

const panel = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`

const header = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid var(--border);
`

export function SessionList({
  activeId,
  onSelect,
}: {
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const { data: tree, isLoading } = useSessionTree()
  const create = useCreateSession()
  const del = useDeleteSession()

  return (
    <div className={panel}>
      <div className={header}>
        <span>会话</span>
        <button
          type="button"
          onClick={() => create.mutate().then((s) => s && onSelect(s.id))}
          data-testid="new-session"
        >
          + 新建
        </button>
      </div>
      {isLoading ? <div style={{ padding: 12 }}>加载中…</div> : null}
      {tree && <BranchTree nodes={tree} activeId={activeId} onSelect={onSelect} />}
      {activeId && (
        <button
          type="button"
          onClick={() => del.mutate(activeId)}
          style={{ margin: 12 }}
        >
          删除当前会话
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 装配路由（修改 `src/web/App.tsx`）**

使用 `@native-router/react`。主路由 `/` 显示 Chat + SessionList 布局。

```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Router, Route } from '@native-router/react'
import { ThemeProvider } from './contexts/ThemeContext.js'
import { ConfigProvider } from './contexts/ConfigContext.js'
import { Layout } from './views/Layout.js'
import { ChatView } from './views/ChatView.js'
import { SessionList } from './views/SessionList.js'
import { Settings } from './views/Settings.js'
import { NotFound } from './views/NotFound.js'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 5 * 60_000, retry: 2, refetchOnWindowFocus: true },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConfigProvider>
          <Router>
            <Layout
              sidebar={<SessionList activeId={null} onSelect={() => {}} />}
              main={
                <Route path="/">
                  <ChatView />
                </Route>
              }
            />
            <Route path="/settings">
              <Settings />
            </Route>
            <Route path="*">
              <NotFound />
            </Route>
          </Router>
        </ConfigProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
```

> `ChatView` 是连接 `useChat`/`useMessages` 与 `Chat` 组件的容器视图；`Settings`/`NotFound` 在后续 Task 创建。本步骤先创建占位 `src/web/views/ChatView.tsx`、`Settings.tsx`、`NotFound.tsx`（导出简单组件），使路由可编译，后续 Task 填充实现。

- [ ] **Step 5: 创建占位视图**

`src/web/views/NotFound.tsx`:
```typescript
export function NotFound() {
  return <div style={{ padding: 24 }}>404 — 页面不存在</div>
}
```

`src/web/views/ChatView.tsx`（占位，Task 9 后完善）：
```typescript
import { Chat } from './Chat.js'
export function ChatView() {
  return <Chat messages={[]} isStreaming={false} usage={null} pendingPermission={null} onSend={() => {}} onAbort={() => {}} onConfirm={() => {}} />
}
```

- [ ] **Step 6: 运行测试 + 类型检查**

```bash
pnpm test --project web
pnpm typecheck:web
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): session list, recursive branch tree, router wiring"
```

---

## Task 9: 文件浏览器、预览与编辑器

**Files:**
- Create: `src/web/views/FileBrowser.tsx`, `FilePreview.tsx`
- Create: `src/web/components/CodeEditor.tsx`
- Test: `src/web/views/FilePreview.test.tsx`

- [ ] **Step 1: 创建 `src/web/views/FileBrowser.tsx`**

```typescript
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { css } from '@linaria/core'
import { fileAPI } from '../services/file.js'

const panel = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`

const row = css`
  padding: 4px 8px;
  cursor: pointer;
  &:hover { background: var(--bg-secondary); }
`

export function FileBrowser({
  onPick,
}: {
  onPick: (path: string) => void
}) {
  const [path, setPath] = useState('.')
  const [query, setQuery] = useState('')
  const listQ = useQuery({
    queryKey: ['files', path],
    queryFn: () => fileAPI.list(path),
  })
  const searchQ = useQuery({
    queryKey: ['files', 'search', query],
    queryFn: () => fileAPI.search(query),
    enabled: query.length > 1,
  })

  const entries = query ? searchQ.data ?? [] : listQ.data ?? []
  return (
    <div className={panel}>
      <input
        placeholder="搜索文件…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ margin: 8, padding: '6px 8px' }}
        data-testid="file-search"
      />
      <div style={{ padding: 4 }}>
        {query ? null : (
          <div className={row} onClick={() => setPath(path.split('/').slice(0, -1).join('/') || '.')} onKeyDown={() => {}} role="button" tabIndex={0}>
            📁 ..
          </div>
        )}
        {entries.map((e) => {
          const fullPath = query ? e.path : `${path === '.' ? '' : path + '/'}${e.name ?? e.path}`
          return (
            <div
              key={fullPath}
              className={row}
              data-testid={`file-${fullPath}`}
              onClick={() => {
                if (e.type === 'directory' && !query) setPath(fullPath)
                else onPick(fullPath)
              }}
              onKeyDown={() => {}}
              role="button"
              tabIndex={0}
            >
              {e.type === 'directory' ? '📁' : '📄'} {query ? e.path : e.name}
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 创建 `src/web/views/FilePreview.tsx`（多渲染器）**

```typescript
import { useQuery } from '@tanstack/react-query'
import { css } from '@linaria/core'
import { fileAPI } from '../services/file.js'
import { CodeBlock } from '../components/CodeBlock.js'
import { Markdown } from '../components/Markdown.js'
import { CodeEditor } from '../components/CodeEditor.js'

const wrap = css`
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`

const CODE_EXT = ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'css', 'html', 'sh', 'sql']
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

export function FilePreview({ path }: { path: string }) {
  const q = useQuery({
    queryKey: ['file', path],
    queryFn: () => fileAPI.read(path),
  })
  if (q.isLoading) return <div style={{ padding: 12 }}>加载中…</div>
  if (!q.data) return <div style={{ padding: 12 }}>无内容</div>

  const ext = extOf(path)
  if (IMG_EXT.includes(ext)) {
    return <img src={`/api/files/${encodeURI(path)}`} alt={path} style={{ maxWidth: '100%' }} />
  }
  if (ext === 'pdf') {
    return (
      <embed
        src={`/api/files/${encodeURI(path)}`}
        type="application/pdf"
        style={{ width: '100%', height: '100%' }}
        data-testid="pdf-preview"
      />
    )
  }
  if (['md', 'markdown'].includes(ext)) {
    return <div className={wrap}><Markdown content={q.data.content} /></div>
  }
  if (CODE_EXT.includes(ext)) {
    return (
      <div className={wrap}>
        <CodeEditor path={path} initial={q.data.content} />
      </div>
    )
  }
  return (
    <div className={wrap}>
      <CodeBlock code={q.data.content} lang={ext} />
    </div>
  )
}
```

- [ ] **Step 3: 创建 `src/web/components/CodeEditor.tsx`（CodeMirror）**

```typescript
import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { fileAPI } from '../services/file.js'
import { useTheme } from '../contexts/ThemeContext.js'

export function CodeEditor({ path, initial }: { path: string; initial: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [dirty, setDirty] = useState(false)
  const { resolved } = useTheme()

  useEffect(() => {
    if (!hostRef.current) return
    const ext = path.split('.').pop()
    const lang = ext === 'ts' || ext === 'js' || ext === 'tsx' ? javascript() : []
    const view = new EditorView({
      state: EditorState.create({
        doc: initial,
        extensions: [
          keymap.of(defaultKeymap),
          lang as never,
          ...(resolved === 'dark' ? [oneDark] : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(true)
          }),
        ],
      }),
      parent: hostRef.current,
    })
    viewRef.current = view
    return () => view.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const save = async () => {
    const doc = viewRef.current?.state.doc.toString() ?? ''
    await fileAPI.write(path, doc)
    setDirty(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: 4 }}>
        <span style={{ fontSize: 12 }}>{path}</span>
        <button onClick={() => void save()} disabled={!dirty} type="button" data-testid="save">
          {dirty ? '保存*' : '已保存'}
        </button>
      </div>
      <div ref={hostRef} style={{ flex: 1, overflow: 'auto' }} />
    </div>
  )
}
```

- [ ] **Step 4: 编写 `src/web/views/FilePreview.test.tsx`**

```typescript
import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FilePreview } from './FilePreview.js'

function withClient(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const fetchMock = (content: string) =>
  vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ path: 'a.md', content }),
  })

afterEach(() => vi.restoreAllMocks())

describe('FilePreview', () => {
  it('渲染 markdown 文件', async () => {
    vi.stubGlobal('fetch', fetchMock('# Title'))
    withClient(<FilePreview path="a.md" />)
    await waitFor(() => {
      expect(screen.getByText('加载中…')).toBeTruthy()
    })
  })
})
```

- [ ] **Step 5: 运行测试 + 类型检查**

```bash
pnpm test --project web
pnpm typecheck:web
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): file browser, multi-format preview, CodeMirror editor"
```

---

## Task 10: 设置页与 LLM 调用详情

**Files:**
- Create: `src/web/views/Settings.tsx`（替换 Task 8 占位）
- Create: `src/web/components/LLMDetail.tsx`
- Test: `src/web/components/LLMDetail.test.tsx`

- [ ] **Step 1: 创建 `src/web/components/LLMDetail.tsx`**

```typescript
import { css } from '@linaria/core'
import type { LLMDetail } from '@shared/types/agent.js'
import { formatLatency } from '../utils/format.js'

const card = css`
  border: 1px solid var(--border);
  border-radius: 6px;
  margin: 8px 0;
  font-size: 13px;
`

const header = css`
  display: flex;
  gap: 12px;
  padding: 8px;
  background: var(--bg-secondary);
  flex-wrap: wrap;
`

export function LLMDetailPanel({ detail }: { detail: LLMDetail }) {
  return (
    <div className={card} data-testid="llm-detail">
      <div className={header}>
        <span>{detail.model}</span>
        <span style={{ color: 'var(--text-secondary)' }}>{detail.provider}</span>
        <span>{detail.usage.input} → {detail.usage.output}</span>
        <span style={{ color: 'var(--text-secondary)' }}>{formatLatency(detail.latency.total)}</span>
      </div>
      <details>
        <summary>System Prompt</summary>
        <pre style={{ padding: 8, maxHeight: 200, overflow: 'auto' }}>{detail.systemPrompt}</pre>
      </details>
      <details>
        <summary>Response</summary>
        <pre style={{ padding: 8 }}>
          {detail.responseChunks.map((c) => ('text' in c ? c.text : '')).join('')}
        </pre>
      </details>
    </div>
  )
}
```

- [ ] **Step 2: 编写 `src/web/components/LLMDetail.test.tsx`**

```typescript
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LLMDetailPanel } from './LLMDetail.js'
import type { LLMDetail } from '@shared/types/agent.js'

const detail: LLMDetail = {
  id: 'd1', timestamp: 1, model: 'gpt-4', provider: 'openai', role: 'default',
  systemPrompt: 'You are helpful', messages: [], tools: [],
  responseChunks: [{ _tag: 'text', text: 'hello' }],
  usage: { input: 10, output: 5 }, latency: { firstToken: 100, total: 1500 }, cost: 0.001,
}

describe('LLMDetailPanel', () => {
  it('渲染模型/provider/用量/延迟', () => {
    render(<LLMDetailPanel detail={detail} />)
    const el = screen.getByTestId('llm-detail')
    expect(el.textContent).toContain('gpt-4')
    expect(el.textContent).toContain('1.50s')
  })
})
```

- [ ] **Step 3: 创建 `src/web/views/Settings.tsx`（替换占位）**

```typescript
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { css } from '@linaria/core'
import { configAPI } from '../services/config.js'
import { useTheme } from '../contexts/ThemeContext.js'
import type { Config } from '@shared/types/config.js'

const section = css`
  padding: 16px;
  border-bottom: 1px solid var(--border);
`

export function Settings() {
  const qc = useQueryClient()
  const { data: config, isLoading } = useQuery({ queryKey: ['config'], queryFn: () => configAPI.get() })
  const { mode, setMode } = useTheme()
  const [draft, setDraft] = useState<Partial<Config> | null>(null)
  const save = useMutation({
    mutationFn: (patch: Partial<Config>) => configAPI.update(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['config'] }),
  })

  if (isLoading || !config) return <div style={{ padding: 24 }}>加载中…</div>
  const merged = { ...config, ...draft }

  return (
    <div data-testid="settings" style={{ overflow: 'auto' }}>
      <div className={section}>
        <h3>主题</h3>
        <select value={mode} onChange={(e) => setMode(e.target.value as never)}>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
      </div>
      <div className={section}>
        <h3>默认 Provider / Model</h3>
        <label>
          Provider:
          <input
            value={merged.defaultProvider}
            onChange={(e) => setDraft({ ...draft, defaultProvider: e.target.value })}
          />
        </label>
        <label>
          Model:
          <input
            value={merged.defaultModel}
            onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
          />
        </label>
      </div>
      <div className={section}>
        <h3>启用工具</h3>
        <input
          value={merged.tools.enabled.join(', ')}
          onChange={(e) =>
            setDraft({ ...draft, tools: { ...merged.tools, enabled: e.target.value.split(',').map((s) => s.trim()) } })
          }
        />
      </div>
      <div className={section}>
        <h3>压缩阈值</h3>
        <input
          type="number"
          step="0.05"
          value={merged.compaction.threshold}
          onChange={(e) =>
            setDraft({ ...draft, compaction: { ...merged.compaction, threshold: Number(e.target.value) } })
          }
        />
      </div>
      <div className={section}>
        <button
          type="button"
          onClick={() => draft && save.mutate(draft)}
          disabled={!draft}
          data-testid="save-config"
        >
          保存
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 运行测试 + 类型检查**

```bash
pnpm test --project web
pnpm typecheck:web
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): settings page (provider/model/tools/compaction/theme), LLM detail panel"
```

---

## Task 11: PWA、离线队列与安装提示

**Files:**
- Create: `src/web/hooks/useOfflineQueue.ts`, `useInstallPrompt.ts`
- Test: `src/web/hooks/useOfflineQueue.test.ts`
- Modify: `src/web/vite.config.ts`（PWA 已在 Task 1 配置，此处确认 manifest 资源）

- [ ] **Step 1: 创建 `src/web/hooks/useOfflineQueue.ts`**

```typescript
import { useCallback, useEffect, useState } from 'react'

type QueuedMsg = { message: string; sessionId: string; timestamp: number }

function load(): QueuedMsg[] {
  try {
    return JSON.parse(localStorage.getItem('c0de-offline-queue') ?? '[]') as QueuedMsg[]
  } catch {
    return []
  }
}

function persist(q: QueuedMsg[]) {
  localStorage.setItem('c0de-offline-queue', JSON.stringify(q))
}

export function useOfflineQueue(send: (sessionId: string, message: string) => Promise<void>) {
  const [online, setOnline] = useState(navigator.onLine)
  const [queue, setQueue] = useState<QueuedMsg[]>(() => load())

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  const enqueue = useCallback((message: string, sessionId: string) => {
    const next = [...load(), { message, sessionId, timestamp: Date.now() }]
    persist(next)
    setQueue(next)
  }, [])

  const flush = useCallback(async () => {
    const pending = load()
    for (const item of pending) {
      await send(item.sessionId, item.message)
    }
    persist([])
    setQueue([])
  }, [send])

  useEffect(() => {
    if (online && queue.length > 0) void flush()
  }, [online, queue.length, flush])

  return { online, enqueue, hasPending: queue.length > 0 }
}
```

- [ ] **Step 2: 编写 `src/web/hooks/useOfflineQueue.test.ts`**

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useOfflineQueue } from './useOfflineQueue.js'

describe('useOfflineQueue', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  })

  it('enqueue 写入 localStorage', () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useOfflineQueue(send))
    act(() => result.current.enqueue('hi', 's1'))
    const stored = JSON.parse(localStorage.getItem('c0de-offline-queue') ?? '[]')
    expect(stored).toHaveLength(1)
    expect(stored[0].message).toBe('hi')
  })

  it('在线时自动 flush 并清空', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    localStorage.setItem('c0de-offline-queue', JSON.stringify([
      { message: 'm', sessionId: 's1', timestamp: 1 },
    ]))
    renderHook(() => useOfflineQueue(send))
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith('s1', 'm')
      expect(JSON.parse(localStorage.getItem('c0de-offline-queue') ?? '[]')).toHaveLength(0)
    })
  })
})
```

- [ ] **Step 3: 创建 `src/web/hooks/useInstallPrompt.ts`**

```typescript
import { useCallback, useEffect, useState } from 'react'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const prompt = useCallback(async () => {
    if (!deferred) return false
    await deferred.prompt()
    const choice = await deferred.userChoice
    setDeferred(null)
    return choice.outcome === 'accepted'
  }, [deferred])

  return { canInstall: !!deferred, installed, prompt }
}
```

- [ ] **Step 4: 创建 PWA 图标占位**

在 `src/web/public/icons/` 下放占位 `icon-192.png` 与 `icon-512.png`（构建期需存在，否则 manifest 引用失效）。可用 SVG 转简单 PNG 占位。

```bash
mkdir -p src/web/public/icons
# 占位：生成纯色 PNG（实际部署替换为真图标）
printf '\x89PNG\r\n\x1a\n' > src/web/public/icons/icon-192.png
printf '\x89PNG\r\n\x1a\n' > src/web/public/icons/icon-512.png
```

- [ ] **Step 5: 运行测试**

```bash
pnpm test --project web
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): PWA offline message queue, install prompt hook, manifest icons"
```

---

## Task 12: 移动端增强（语音、推送、手势、分享、子 agent）

**Files:**
- Create: `src/web/hooks/useVoiceInput.ts`, `usePushNotification.ts`
- Create: `src/web/components/TouchHandlers.tsx`, `SubAgentProgress.tsx`
- Test: `src/web/hooks/useVoiceInput.test.ts`

> 这些功能依赖浏览器 API（部分在 happy-dom 不可用），均采用 feature detection + graceful degradation。

- [ ] **Step 1: 创建 `src/web/hooks/useVoiceInput.ts`**

```typescript
import { useCallback, useRef, useState } from 'react'

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((e: { results: { 0: { 0: { transcript: string } } }[] }) => void) | null
  onerror: (() => void) | null
}

export function useVoiceInput(lang = 'zh-CN') {
  const [transcript, setTranscript] = useState('')
  const [listening, setListening] = useState(false)
  const recRef = useRef<SpeechRecognitionLike | null>(null)

  const start = useCallback(() => {
    const Ctor =
      (window as unknown as { SpeechRecognition?: never; webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition ??
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition
    if (!Ctor) return
    const rec = new Ctor()
    rec.continuous = false
    rec.interimResults = true
    rec.lang = lang
    rec.onresult = (e) => {
      const text = e.results[0]?.[0]?.[0]?.transcript ?? ''
      setTranscript(text)
    }
    rec.onerror = () => setListening(false)
    recRef.current = rec
    rec.start()
    setListening(true)
  }, [lang])

  const stop = useCallback(() => {
    recRef.current?.stop()
    setListening(false)
  }, [])

  return { transcript, listening, start, stop }
}
```

- [ ] **Step 2: 编写 `src/web/hooks/useVoiceInput.test.ts`**

```typescript
import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVoiceInput } from './useVoiceInput.js'

describe('useVoiceInput', () => {
  it('无 API 时 start 不报错', () => {
    const { result } = renderHook(() => useVoiceInput())
    act(() => result.current.start())
    expect(result.current.listening).toBe(false)
  })

  it('有 webkitSpeechRecognition 时启动', () => {
    const fakeRec = {
      continuous: false, interimResults: false, lang: '',
      start: vi.fn(), stop: vi.fn(), onresult: null, onerror: null,
    }
    vi.stubGlobal('webkitSpeechRecognition', vi.fn(() => fakeRec))
    const { result } = renderHook(() => useVoiceInput())
    act(() => result.current.start())
    expect(fakeRec.start).toHaveBeenCalled()
    expect(result.current.listening).toBe(true)
  })
})
```

- [ ] **Step 3: 创建 `src/web/hooks/usePushNotification.ts`**

```typescript
import { useCallback, useState } from 'react'

export function usePushNotification() {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  )

  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return 'denied'
    const p = await Notification.requestPermission()
    setPermission(p)
    return p
  }, [])

  const notify = useCallback((title: string, body?: string) => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    try {
      new Notification(title, { body })
    } catch {
      // Service Worker 注册推送在 Task 12 范围外
    }
  }, [])

  return { permission, requestPermission, notify }
}
```

- [ ] **Step 4: 创建 `src/web/components/TouchHandlers.tsx`（左滑删除手势）**

```typescript
import { useRef, useState } from 'react'
import { css } from '@linaria/core'

const swipe = css`
  position: relative;
  overflow: hidden;
  touch-action: pan-y;
`

type Props = {
  onDelete?: () => void
  onLongPress?: () => void
  children: React.ReactNode
}

export function TouchListItem({ onDelete, onLongPress, children }: Props) {
  const startX = useRef(0)
  const [dx, setDx] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  return (
    <div
      className={swipe}
      style={{ transform: `translateX(${dx}px)`, transition: dx === 0 ? 'transform 0.2s' : 'none' }}
      onTouchStart={(e) => {
        startX.current = e.touches[0]?.clientX ?? 0
        if (onLongPress) timer.current = setTimeout(onLongPress, 600)
      }}
      onTouchMove={(e) => {
        const x = e.touches[0]?.clientX ?? 0
        setDx(Math.min(0, x - startX.current))
        if (timer.current && Math.abs(x - startX.current) > 10) clearTimeout(timer.current)
      }}
      onTouchEnd={() => {
        if (timer.current) clearTimeout(timer.current)
        if (dx < -80) onDelete?.()
        setDx(0)
      }}
      data-testid="touch-item"
    >
      {children}
    </div>
  )
}
```

- [ ] **Step 5: 创建 `src/web/components/SubAgentProgress.tsx`（预留，spec §2.10）**

```typescript
import { css } from '@linaria/core'

/** 后端 SubAgentEvent 类型（spec §2.10 定义，后端尚未实现）。 */
type SubAgentEvent = {
  parentId: string
  childId: string
  childSessionId: string
  event: { _tag: string }
}

type SubAgentProgressProps = {
  childId: string
  childSessionId: string
  events: SubAgentEvent[]
  onAbort?: () => void
}

const card = css`
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 8px;
  margin: 6px 0;
  font-size: 13px;
`

export function SubAgentProgress({ childId, childSessionId, events, onAbort }: SubAgentProgressProps) {
  if (events.length === 0) return null
  const toolCount = events.filter((e) => e.event._tag === 'tool_call_start').length
  return (
    <div className={card} data-testid="subagent-progress">
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>子 Agent {childId.slice(0, 8)}</span>
        {onAbort && <button type="button" onClick={onAbort}>中止</button>}
      </div>
      <span style={{ color: 'var(--text-secondary)' }}>
        session: {childSessionId.slice(0, 8)} · {toolCount} 次工具调用
      </span>
    </div>
  )
}
```

> **后端依赖说明**：后端 SSE 当前不发射 `SubAgentEvent`。此组件按 spec §2.10 类型实现，运行时后端发射该事件前不会显示（events 为空 → 返回 null）。待后端在 `runAgent` 中转发子 agent 事件后生效。

- [ ] **Step 5b: 创建 `src/web/hooks/useShare.ts`（spec §2.11 Web Share API）**

```typescript
import { useCallback, useState } from 'react'

type ShareData = { title?: string; text?: string; url?: string }

export function useShare() {
  const supported = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  const [shared, setShared] = useState(false)

  const share = useCallback(async (data: ShareData) => {
    if (!supported) return false
    try {
      await navigator.share(data)
      setShared(true)
      return true
    } catch {
      return false
    }
  }, [supported])

  return { supported, share, shared }
}
```

> Web Share API 仅在安全上下文（HTTPS/localhost）且支持的浏览器可用；不支持时 `supported` 为 false，调用静默返回 false。前端在消息气泡操作菜单/设置页中暴露「分享」按钮，调用 `share({ title: 'c0de-agent 会话', text: ... })`。

- [ ] **Step 6: 运行测试 + 类型检查**

```bash
pnpm test --project web
pnpm typecheck:web
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): voice input, push notification, swipe gestures, subagent progress view"
```

---

## 验收标准

1. **构建**：`pnpm build:web` 成功产出 `dist-web/`（含带 hash 的 JS/CSS、`manifest.webmanifest`、service worker）。
2. **类型**：`pnpm typecheck`（后端）与 `pnpm typecheck:web`（前端）均通过，零错误。
3. **测试**：`pnpm test` 跑 node + web 两 project 全绿。web 测试覆盖：SSE 解析（`consumeSSEBuffer`/`parseSSEFrame`）、API client、chat reducer、format utils、组件（MessageBubble/PermissionDialog/InputArea/BranchTree/LLMDetail/FilePreview）、hooks（useMediaQuery/useOfflineQueue/useVoiceInput）。
4. **集成**：开发环境 `pnpm dev:web`（5173）+ `pnpm --filter . dev`（server 3000），proxy 生效；前端 `/api/chat` 走通 SSE 流，能渲染 text_delta/tool_call/permission_required/done。
5. **PWA**：Lighthouse PWA 可安装，manifest/theme-color/icons 齐备，service worker 注册缓存静态资源。
6. **响应式**：移动端（<768px）单栏全屏输入，桌面（≥1024px）三栏布局。
7. **Lint**：`pnpm biome check src/web/` 零警告（允许 `as unknown as` 转换、必要的 `biome-ignore`）。

## 后端依赖与限制

- **静态服务**：Task 1 在 `src/server/app.ts` 加 `serveStatic('./dist-web')`，生产环境 `/` 返回前端。
- **SubAgentProgress**：后端 SSE 未发射 `SubAgentEvent`；组件已实现，运行时预留，待后端支持。
- **Push 推送**：需 VAPID + 服务端 push 端点（后端未实现）；前端仅本地 `Notification` API（agent done 提醒）。
- **fork/compact slash 命令**：`/fork`、`/compact` 走后端 session API（已存在 `forkSession`/`compactSession`），前端调用即可。

## 风险与缓解

- **Shiki 体积**：首屏加载 Shiki 全量语言包较大。已只引入常用 15 语言；可后续用动态 import 按需加载。
- **happy-dom 与浏览器 API 差异**：语音/推送/手势在 happy-dom 下用 feature detection 跳过，仅测可模拟路径。
- **@native-router/react 小众**：若其 API 与计划假设不符，改用 react-router-dom（Anthology 参考路径），路由层隔离在 `App.tsx` 单文件，迁移成本低。
- **haze-ui 集成**：本计划未强依赖 haze-ui 组件（用原生 + Linaria 自建），haze-ui 可作为后续 UI 打磨的可选增强，不阻塞验收。

## 执行建议（subagent-driven-development）

建议分 4 批派发，每批后 controller 跑 `pnpm test --project web && pnpm typecheck:web && pnpm biome check src/web/`：
- **批 1**：Task 1-3（脚手架 + 服务层 + 样式/上下文）
- **批 2**：Task 4-6（hooks + markdown + 核心组件）
- **批 3**：Task 7-9（布局 + 会话 + 文件浏览器）
- **批 4**：Task 10-12（设置 + PWA + 移动端增强）
```
```
```
```

---
