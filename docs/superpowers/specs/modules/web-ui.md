# Web UI 详细设计

> 基于 painless、anthology、opencode 的实现分析。

## 1. 参考项目分析

### 1.1 Painless（前端模式参考）

**技术栈**：React 19 + haze-ui + @linaria + @native-router/react

**组件模式**：
- `views/`：页面级组件（Layout、Home、Article、Login、Register、Editor）
- `components/`：通用组件（DevTool、Loading、Preview、Popover、RouterError）
- `services/`：薄 fetch 封装
- `hooks/`：自定义 hooks
- `types/`：类型定义

**路由**：@native-router/react，声明式路由配置（用户自有库）

**样式**：@linaria 零运行时 CSS，CSS-in-JS 编译时提取

### 1.2 Anthology（后端 + 前端模式参考）

**前端技术栈**：React 19 + react-router-dom + TanStack Query + Linaria + haze-ui

**App 结构**（`App.tsx`）：
- BrowserRouter + lazy 路由
- AuthContext 认证上下文
- TanStack Query 数据获取
- haze-ui 主题

**页面模式**（21 个页面组件）：
- 每个页面独立文件
- Linaria CSS 样式
- 表单使用 zod 验证

**Hooks**：
- `useAuth`：认证状态
- `useTheme`：主题切换
- `useQueryClient`：数据获取
- `useRoutePrefetch`：路由预取

### 1.3 OpenCode（Web App 模式参考）

**技术栈**：SolidJS（不同于我们的 React 选择）

**关键特性**：
- Shiki 语法高亮
- marked Markdown 渲染
- 文件浏览器
- Session UI
- Context providers

---

## 2. c0de-agent Web UI 设计

### 2.1 技术栈

- React 19
- @native-router/react（路由）
- @tanstack/react-query v5（数据获取）
- haze-ui（组件库）
- @linaria/core + @linaria/react（零运行时 CSS）
- Vite + vite-plugin-pwa（构建 + PWA）
- Shiki（代码语法高亮）
- marked（Markdown 渲染）

### 2.2 项目结构

```
src/web/
├── App.tsx                根组件
├── main.tsx               入口
├── router.tsx             路由配置
├── views/
│   ├── Layout/            响应式布局
│   ├── Chat/              主聊天界面
│   ├── SessionList/       会话列表 + 分支树
│   ├── FileBrowser/       文件浏览器
│   ├── FilePreview/       文件预览
│   ├── Settings/          设置页面
│   └── NotFound/          404
├── components/
│   ├── MessageBubble/     消息气泡
│   ├── ToolCall/          工具调用展示
│   ├── BranchTree/        分支可视化
│   ├── CodeBlock/         代码块渲染 + 引用
│   ├── CodeEditor/        代码编辑器
│   ├── Markdown/          Markdown 渲染
│   ├── PermissionDialog/  权限确认弹窗
│   ├── StreamingIndicator/ 流式指示器
│   ├── LLMDetail/         LLM 调用详情
│   └── SlashCommand/      命令输入
├── services/
│   ├── api.ts             API 客户端基类
│   ├── chat.ts            聊天 API（SSE）
│   ├── session.ts         会话 API
│   ├── file.ts            文件 API
│   ├── config.ts          配置 API
│   └── agent.ts           Agent 控制（abort、steering、permission confirm）
├── hooks/
│   ├── useChat.ts         聊天状态管理
│   ├── useSession.ts      会话状态
│   ├── useAgent.ts        agent 状态
│   ├── useFile.ts         文件操作
│   └── useMediaQuery.ts   响应式断点
├── contexts/
│   ├── ThemeContext.tsx    主题上下文
│   └── ConfigContext.tsx   配置上下文
├── styles/
│   ├── global.ts          全局样式
│   ├── theme.ts           主题变量
│   └── breakpoints.ts     断点定义
│   └── utils/
│       ├── markdown.ts        Markdown 渲染
│       ├── highlight.ts       代码高亮
│       └── format.ts          格式化工具
├── index.html
├── public/                  静态资源
│   ├── manifest.json        PWA manifest
│   ├── sw.js                Service Worker
│   └── icons/               应用图标
├── vite.config.ts
├── tsconfig.json
└── package.json
```

### 2.3 PWA + HTTP 强缓存配置

```typescript
// vite.config.ts
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  build: {
    // 文件名带 content hash，支持强缓存
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name].[hash][extname]',
        chunkFileNames: 'assets/[name].[hash].js',
        entryFileNames: 'assets/[name].[hash].js'
      }
    }
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'c0de-agent',
        short_name: 'c0de',
        description: 'AI Coding Assistant',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        // 不变资源（带 hash 的文件）强缓存 1 周
        runtimeCaching: [
          {
            urlPattern: /\.[0-9a-f]{8,}\./,  // 匹配带 hash 的文件
            handler: 'CacheFirst',
            options: {
              cacheName: 'static-assets',
              expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 60 * 60 },  // 1 周
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            urlPattern: /^https?:\/\/localhost:\d+\/api\//,
            handler: 'NetworkFirst',
            options: { cacheName: 'api-cache', expiration: { maxEntries: 50, maxAgeSeconds: 300 } }
          }
        ]
      }
    })
  ]
})
```

### 2.4 响应式布局

**断点**：
```typescript
const breakpoints = {
  mobile: '(max-width: 767px)',
  tablet: '(min-width: 768px) and (max-width: 1023px)',
  desktop: '(min-width: 1024px)'
}
```

**Layout 组件**：
```typescript
// 移动端：底部 Tab 导航，全屏内容
// 平板：侧边栏可折叠，主内容区
// 桌面：固定侧边栏 + 主内容区 + 可选右侧面板

type LayoutProps = {
  sidebar: React.ReactNode    // 会话列表
  main: React.ReactNode       // 聊天/文件浏览器
  panel?: React.ReactNode     // 文件预览/详情
}
```

**移动端优先 CSS**：
```css
/* 默认：移动端 */
.layout {
  display: flex;
  flex-direction: column;
  height: 100dvh;
}

.sidebar {
  display: none; /* 移动端通过 Tab 切换 */
}

.main {
  flex: 1;
  overflow: auto;
}

/* 平板 */
@media (min-width: 768px) {
  .layout {
    flex-direction: row;
  }
  .sidebar {
    display: block;
    width: 280px;
    border-right: 1px solid var(--border);
  }
}

/* 桌面 */
@media (min-width: 1024px) {
  .sidebar {
    width: 320px;
  }
}
```

### 2.5 聊天界面

**组件层次**：
```
ChatView
├── SessionList（侧边栏）
│   ├── SessionItem
│   └── BranchTree
├── MessageStream（主区域）
│   ├── MessageBubble
│   │   ├── Markdown（渲染内容）
│   │   ├── CodeBlock（代码块 + 引用按钮）
│   │   └── ToolCall（工具调用展开）
│   ├── StreamingIndicator（流式输入）
│   └── LLMDetail（可展开的调用详情）
└── InputArea（底部）
    ├── TextArea（自动扩展）
    ├── SlashCommandMenu（/ 命令提示）
    └── SendButton
```

**SSE 消费**（`useChat.ts`）：
```typescript
function useChat(sessionId: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)

  const sendMessage = async (content: string) => {
    setIsStreaming(true)

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: content })
    })

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const text = decoder.decode(value)
      const events = parseSSE(text)

      for (const event of events) {
        switch (event.type) {
          case 'text_delta':
            // 追加到当前 assistant 消息
            break
          case 'tool_call_start':
            // 显示工具调用卡片
            break
          case 'tool_call_end':
            // 更新工具调用结果
            break
          case 'permission_required':
            // 弹出确认对话框
            break
          case 'done':
            setIsStreaming(false)
            break
        }
      }
    }
  }

  return { messages, sendMessage, isStreaming }
}
```

### 2.6 文件浏览器

```
FileBrowser
├── Breadcrumb（路径导航）
├── SearchBar（文件搜索）
├── FileTree（树形目录）
│   ├── FolderNode（可展开/折叠）
│   └── FileNode（点击预览）
└── FilePreview（右侧预览面板）
    ├── CodePreview（Shiki 高亮）
    ├── ImagePreview（内联图片）
    ├── MarkdownPreview（渲染 Markdown）
    └── PDFPreview（PDF 查看器）
```

**API**：
```typescript
// 列出目录
GET /api/files?path=src/components

// 读取文件
GET /api/files/src/main.ts

// 搜索文件
GET /api/files/search?q=useState

// 写入文件
PUT /api/files/src/main.ts
Body: { content: "..." }
```

### 2.7 特殊文件渲染

```typescript
// 根据文件扩展名选择渲染器
function getRenderer(filename: string): Renderer {
  const ext = filename.split('.').pop()?.toLowerCase()

  // 图片
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
    return ImageRenderer
  }

  // Markdown
  if (['md', 'markdown'].includes(ext)) {
    return MarkdownRenderer
  }

  // PDF
  if (ext === 'pdf') {
    return PDFRenderer
  }

  // 代码（Shiki 高亮）
  if (ext && shikiLangs.includes(ext)) {
    return CodeRenderer
  }

  // JSON/YAML
  if (['json', 'yaml', 'yml'].includes(ext)) {
    return JSONRenderer  // 语法高亮 + 折叠
  }

  // 纯文本
  return TextRenderer
}
```

### 2.8 代码块引用

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

// 在输入框中引用代码
// 格式：@[src/main.ts:10-20] 或 @[msg_abc:2]
function parseCodeReference(text: string): CodeReference | null

// 渲染引用的代码块
function CodeReferenceBlock({ ref }: { ref: CodeReference }) {
  // 获取代码内容
  // Shiki 高亮
  // 显示行号
  // 点击跳转到文件浏览器
}
```

### 2.9 LLM 调用详情

```typescript
// 展示每次 LLM 调用的完整详情
function LLMDetailPanel({ detail }: { detail: LLMDetail }) {
  return (
    <div>
      <header>
        <span>{detail.model}</span>
        <span>{detail.provider}</span>
        <span>{detail.usage.input} → {detail.usage.output} tokens</span>
        <span>{detail.latency.total}ms</span>
      </header>

      {/* 可折叠的详情 */}
      <Collapsible title="System Prompt">
        <pre>{detail.systemPrompt}</pre>
      </Collapsible>

      <Collapsible title="Messages ({detail.messages.length})">
        {detail.messages.map(msg => <MessageView message={msg} />)}
      </Collapsible>

      <Collapsible title="Tools ({detail.tools.length})">
        {detail.tools.map(tool => <ToolSchemaView tool={tool} />)}
      </Collapsible>

      <Collapsible title="Response">
        <pre>{detail.responseChunks.map(c => c.text).join('')}</pre>
      </Collapsible>
    </div>
  )
}
```

### 2.10 子 Agent 进度视图

当 task 工具 spawn 子 agent 时，前端需要展示子 agent 的实时进度：

```typescript
type SubAgentEvent = {
  parentId: string
  childId: string
  childSessionId: string
  event: AgentEvent
}

function SubAgentProgress({ childId, childSessionId }: { childId: string; childSessionId: string }) {
  // 显示：子 agent 名称、当前状态、已执行工具数、token 用量
  // 可展开查看子 agent 的消息流
  // 可中止子 agent
}
```

### 2.11 离线 Agent 状态管理

PWA 离线时的处理：
- 已有会话历史可浏览（Service Worker 缓存）
- 文件浏览器可浏览已缓存文件
- 发送消息时提示“离线中，消息将在恢复连接后发送”
- 恢复连接后自动发送排队的消息
- Agent 执行状态通过 SSE 流保持，离线时显示最后已知状态

```typescript
function useOfflineQueue() {
  const queue: { message: string; sessionId: string; timestamp: number }[] = []
  const enqueue = (message: string, sessionId: string) => {
    queue.push({ message, sessionId, timestamp: Date.now() })
    localStorage.setItem('offlineQueue', JSON.stringify(queue))
  }
  const flush = async () => {
    for (const item of queue) await sendMessage(item.sessionId, item.message)
    queue.length = 0
    localStorage.removeItem('offlineQueue')
  }
  return { enqueue, flush, hasPending: queue.length > 0 }
}
```

### 2.12 触摸交互

- **按钮最小尺寸**：44px × 44px
- **滑动手势**：左滑删除会话，右滑返回
- **长按菜单**：长按消息弹出操作菜单（复制、引用、重新生成）
- **下拉刷新**：下拉加载更多历史消息
- **捏合缩放**：代码块和图片支持捏合缩放

### 2.11 移动端特有功能

```typescript
// 语音输入（Web Speech API）
function useVoiceInput() {
  const recognition = new webkitSpeechRecognition()
  recognition.continuous = false
  recognition.interimResults = true
  recognition.lang = 'zh-CN'

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
    result: '' // 实时识别结果
  }
}

// 推送通知（Push API）
function usePushNotification() {
  // agent 完成任务时推送通知
  // 需要 Service Worker 支持
}

// 分享目标（Web Share API）
function useShare() {
  // 从其他应用分享文本到 c0de
  // navigator.share({ title, text, url })
}
```

### 2.12 API Client

```typescript
// services/api.ts - 通用 API 客户端
const API_BASE = ''  // 同源

type APIError = {
  status: number
  message: string
  code?: string
}

async function apiRequest<T>(path: string, opts?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...opts?.headers
    },
    credentials: 'same-origin'
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText }))
    throw { status: response.status, message: body.message, code: body.code } as APIError
  }

  return response.json()
}

// services/chat.ts - SSE 聊天客户端
async function sendChatMessage(
  sessionId: string,
  message: string,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
    signal
  })

  if (!response.ok) throw await response.json()

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6))
        onEvent(data)
      }
    }
  }
}

// services/session.ts
const sessionAPI = {
  list: () => apiRequest<Session[]>('/api/sessions'),
  get: (id: string) => apiRequest<Session>(`/api/sessions/${id}`),
  create: (title?: string) => apiRequest<Session>('/api/sessions', { method: 'POST', body: JSON.stringify({ title }) }),
  fork: (id: string, entryId: string) => apiRequest<Session>(`/api/sessions/${id}/fork`, { method: 'POST', body: JSON.stringify({ entryId }) }),
  delete: (id: string) => apiRequest<void>(`/api/sessions/${id}`, { method: 'DELETE' }),
  messages: (id: string, opts?: { limit?: number; offset?: number }) =>
    apiRequest<Message[]>(`/api/sessions/${id}/messages?${new URLSearchParams(opts as Record<string, string>)}`),
  llmDetails: (id: string) => apiRequest<LLMDetail[]>(`/api/sessions/${id}/llm-details`)
}

// services/file.ts
const fileAPI = {
  list: (path: string) => apiRequest<FileEntry[]>(`/api/files?path=${encodeURIComponent(path)}`),
  read: (path: string) => apiRequest<{ content: string; hash: string }>(`/api/files/${encodeURIComponent(path)}`),
  write: (path: string, content: string) => apiRequest<void>(`/api/files/${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  search: (query: string) => apiRequest<FileSearchResult[]>(`/api/files/search?q=${encodeURIComponent(query)}`)
}

// services/config.ts
const configAPI = {
  get: () => apiRequest<Config>('/api/config'),
  update: (patch: Partial<Config>) => apiRequest<Config>('/api/config', { method: 'PATCH', body: JSON.stringify(patch) })
}
```

### 2.13 Agent 控制服务（替代 WebSocket）

所有 server→client 推送通过 SSE 流，client→server 操作通过 HTTP POST：

```typescript
// services/agent.ts
const agentAPI = {
  // 中止 agent
  abort: (sessionId: string) =>
    apiRequest<void>(`/api/chat/abort`, { method: 'POST', body: JSON.stringify({ sessionId }) }),

  // 确认工具执行
  confirmTool: (toolCallId: string, approved: boolean) =>
    apiRequest<void>('/api/tools/confirm', { method: 'POST', body: JSON.stringify({ toolCallId, approved }) }),

  // 注入 steering 消息
  steer: (sessionId: string, message: string) =>
    apiRequest<void>('/api/chat/steer', { method: 'POST', body: JSON.stringify({ sessionId, message }) }),

  // 暂停 agent
  pause: (sessionId: string) =>
    apiRequest<void>('/api/chat/pause', { method: 'POST', body: JSON.stringify({ sessionId }) }),

  // 恢复 agent
  resume: (sessionId: string) =>
    apiRequest<void>(`/api/chat/resume`, { method: 'POST', body: JSON.stringify({ sessionId }) })
}
```

SSE 流中包含所有事件类型（见 §2.5 useChat），无需独立的 WebSocket 连接。

### 2.14 TanStack Query 配置

```typescript
// App.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,        // 30s 内不重新获取
      gcTime: 5 * 60_000,       // 5min 后清理缓存
      retry: 2,                 // 重试 2 次
      refetchOnWindowFocus: true // 窗口聚焦时重新获取
    },
    mutations: {
      retry: 1
    }
  }
})

// 使用示例
function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => sessionAPI.list()
  })
}

function useSendMessage(sessionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (message: string) => sendChatMessage(sessionId, message, handleEvent),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions', sessionId, 'messages'] })
    }
  })
}
```

### 2.15 Shiki + Marked 代码渲染

```typescript
// utils/highlight.ts
import { createHighlighter } from 'shiki'

const highlighter = await createHighlighter({
  themes: ['github-dark', 'github-light'],
  langs: ['javascript', 'typescript', 'python', 'rust', 'go', 'java', 'c', 'cpp', 'html', 'css', 'json', 'yaml', 'markdown', 'bash', 'sql']
})

export function highlightCode(code: string, lang: string): string {
  return highlighter.codeToHtml(code, { lang, themes: { dark: 'github-dark', light: 'github-light' } })
}

// utils/markdown.ts
import { marked } from 'marked'
import { highlightCode } from './highlight'

marked.setOptions({
  gfm: true,
  breaks: true
})

// 自定义 renderer：代码块使用 Shiki 高亮
const renderer = new marked.Renderer()
renderer.code = ({ text, lang }) => {
  const highlighted = highlightCode(text, lang ?? 'text')
  return `<div class="code-block" data-lang="${lang}">
    <div class="code-header">
      <span class="lang">${lang}</span>
      <button class="copy-btn">Copy</button>
      <button class="ref-btn">@引用</button>
    </div>
    ${highlighted}
  </div>`
}

export function renderMarkdown(content: string): string {
  return marked.parse(content, { renderer }) as string
}
```

### 2.16 Linaria 主题系统

```typescript
// styles/theme.ts
import { css } from '@linaria/core'

export const lightTheme = {
  bg: '#ffffff',
  bgSecondary: '#f5f5f5',
  text: '#1a1a1a',
  textSecondary: '#666666',
  border: '#e0e0e0',
  primary: '#2563eb',
  primaryHover: '#1d4ed8',
  success: '#16a34a',
  warning: '#d97706',
  error: '#dc2626',
  codeBg: '#f6f8fa',
  shadow: '0 1px 3px rgba(0,0,0,0.1)'
}

export const darkTheme = {
  bg: '#0d1117',
  bgSecondary: '#161b22',
  text: '#e6edf3',
  textSecondary: '#8b949e',
  border: '#30363d',
  primary: '#58a6ff',
  primaryHover: '#79c0ff',
  success: '#3fb950',
  warning: '#d29922',
  error: '#f85149',
  codeBg: '#161b22',
  shadow: '0 1px 3px rgba(0,0,0,0.3)'
}

export const theme = css`
  :global(:root) {
    --bg: ${lightTheme.bg};
    --text: ${lightTheme.text};
    /* ... */
  }
  :global(:root.dark) {
    --bg: ${darkTheme.bg};
    --text: ${darkTheme.text};
    /* ... */
  }
`

// styles/breakpoints.ts
export const MOBILE = '@media (max-width: 767px)'
export const TABLET = '@media (min-width: 768px) and (max-width: 1023px)'
export const DESKTOP = '@media (min-width: 1024px)'
export const TOUCH = '@media (hover: none) and (pointer: coarse)'
```
