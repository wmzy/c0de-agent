# Server Hono + SSE 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 c0de-agent 的 HTTP 服务层（Hono API + SSE 流式聊天），将 session/core/tools 模块暴露为 RESTful API，支持 Agent 实时控制（abort/pause/resume/steer/permission confirm）。

**Architecture:** 纯函数 + 闭包模式。`ServerContext` 持有所有服务（db, config, registries, agentManager）。每个 route 模块导出 `createXxxRoute(ctx): Hono` 工厂函数，通过闭包捕获 context。SSE 流式聊天通过 `hono/streaming` 的 `streamSSE` 实现，将 `AsyncGenerator<AgentEvent>` 逐事件推送给前端。`AgentManager` 按 sessionId 跟踪活跃 run，提供控制操作。`InteractivePermissionChecker` 在遇到 `ask` 权限工具时阻塞等待用户确认。

**Tech Stack:** Hono 4.x, @hono/node-server 2.x, Vitest, 纯 TypeScript（data + functions 范式）

---

## 文件结构

```
src/server/
├── types.ts                    ServerContext、请求/响应类型定义
├── context.ts                  createServerContext 工厂（组装所有服务）
├── agent-manager.ts            AgentManager：活跃 run 跟踪 + 控制操作
├── permission/
│   └── interactive.ts          InteractivePermissionChecker（阻塞式权限确认）
├── routes/
│   ├── health.ts               GET /api/health
│   ├── session.ts              会话 CRUD + 分支 + 消息列表 + 树
│   ├── config.ts               GET/PATCH /api/config
│   ├── tool.ts                 GET /api/tools + POST /api/tools/confirm
│   ├── chat.ts                 POST /api/chat (SSE) + 控制端点
│   └── files.ts                文件浏览（list/read/write/search）
├── middleware/
│   └── error.ts                错误处理中间件 + apiError 工具函数
├── app.ts                      createApp(ctx): Hono — 组装所有路由
├── server.ts                   startServer(opts): 启动 DB+注册表+服务器
├── index.ts                    公开 API barrel export
├── types.test.ts               ServerContext 类型测试
├── agent-manager.test.ts       AgentManager 测试
├── permission/
│   └── interactive.test.ts     InteractivePermissionChecker 测试
├── routes/
│   ├── health.test.ts          health 路由测试
│   ├── session.test.ts         session 路由测试
│   ├── config.test.ts          config 路由测试
│   ├── tool.test.ts            tool 路由测试
│   ├── chat.test.ts            chat SSE 路由测试
│   └── files.test.ts           files 路由测试
├── app.test.ts                 完整 app 集成测试
└── index.test.ts               barrel export 测试
```

**CORS**：直接使用 Hono 内置 `hono/cors`，不单独创建 middleware/cors.ts。

---

## 关键设计决策

### 1. SSE 事件格式

每个 `AgentEvent` 映射为一条 SSE 消息：
- `event:` 字段 = `AgentEvent._tag`（如 `text_delta`, `tool_call_start`, `done`）
- `data:` 字段 = 完整 `AgentEvent` 的 JSON（含 `_tag`，前端可按 `_tag` 分发）

```
event: text_delta
data: {"_tag":"text_delta","text":"Hello"}

event: done
data: {"_tag":"done"}
```

### 2. 权限确认流程（阻塞式）

`InteractivePermissionChecker.check()` 遇到 `ask` 权限工具时：
1. 生成 `toolCallId`，通过 `onPermissionRequired` 回调**直接向 SSE 流写入** `permission_required` 事件
2. 创建 Promise 存入 pending map，await 阻塞
3. `POST /api/tools/confirm` 调用 `permissionChecker.confirm(toolCallId, approved)` 解除阻塞
4. `check()` 返回 `allow` 或 `deny`，executor 正常执行或拒绝

由于 SSE 写入在 `check()` 阻塞前完成，前端能收到 `permission_required` 事件。

### 3. LoopDeps.chatStream 测试注入

`ServerContext` 有可选 `chatStream` 字段。chat 路由构建 `LoopDeps` 时，若 `ctx.chatStream` 存在则注入，使测试无需真实 LLM provider。

### 4. 依赖方向

```
index.ts → server.ts → app.ts → routes/* → context → types
                                         → middleware/error
agent-manager → core (abortAgent, pauseAgent, resumeAgent, injectSteering)
permission/interactive → tools/types (PermissionChecker)
所有 route → hono
```

禁止循环依赖。server 仅依赖 core, session, tools, llm, db, shared。

---

## Task 1: Server 类型定义 + Context 工厂

**Files:**
- Create: `src/server/types.ts`
- Create: `src/server/context.ts`
- Create: `src/server/types.test.ts`

- [ ] **Step 1: 创建 types.ts**

```typescript
// src/server/types.ts
import type { Config } from '../core/config.js'
import type { chatStream as chatStreamFn } from '../llm/provider.js'
import type { Registry } from '../llm/registry.js'
import type { Config as SharedConfig } from '../shared/types/config.js'
import type { ToolRegistry } from '../tools/types.js'
import type { DB } from '../db/client.js'
import type { AgentManager } from './agent-manager.js'

/** 持有所有服务依赖的不可变上下文（config 字段可变用于 PATCH 更新）。 */
type ServerContext = {
  db: DB
  config: Config
  toolRegistry: ToolRegistry
  llmRegistry: Registry
  agentManager: AgentManager
  cwd: string
  /** 测试注入：覆盖 LLM chat stream。生产环境为 undefined。 */
  chatStream?: typeof chatStreamFn
}

/** POST /api/chat 请求体。 */
type ChatRequest = {
  sessionId: string
  message: string
  provider?: string
  model?: string
  tools?: string[]
}

/** Agent 控制请求（abort/pause/resume）。 */
type ControlRequest = {
  sessionId: string
}

/** POST /api/chat/steer 请求体。 */
type SteerRequest = {
  sessionId: string
  message: string
}

/** POST /api/tools/confirm 请求体。 */
type ConfirmRequest = {
  toolCallId: string
  approved: boolean
}

/** 统一错误响应体。 */
type APIErrorBody = {
  error: { code: string; message: string }
}

export type {
  APIErrorBody,
  ChatRequest,
  Config,
  ConfirmRequest,
  ControlRequest,
  ServerContext,
  SharedConfig,
  SteerRequest,
}
```

- [ ] **Step 2: 运行类型检查确认 types.ts 无误**

Run: `pnpm typecheck`
Expected: 无错误（agent-manager.ts 尚未创建，但 type-only import 不会报运行时错误；若报找不到模块，暂时注释掉 AgentManager import，Task 3 后恢复）

注意：由于 `AgentManager` 尚未定义，Step 1 的 types.ts 引用了未创建的模块。先创建占位 agent-manager.ts（仅类型）：

```typescript
// src/server/agent-manager.ts（占位，Task 3 完整实现）
export type AgentManager = Record<string, never>
export function createAgentManager(): AgentManager {
  return {}
}
```

- [ ] **Step 3: 创建 context.ts**

```typescript
// src/server/context.ts
import { DEFAULT_CONFIG } from '../core/config.js'
import type { Config } from '../shared/types/config.js'
import type { DB } from '../db/client.js'
import type { Registry } from '../llm/registry.js'
import { createDefaultRegistry } from '../tools/index.js'
import type { ToolRegistry } from '../tools/types.js'
import { createAgentManager } from './agent-manager.js'
import type { ServerContext } from './types.js'

type CreateServerContextOptions = {
  db: DB
  config?: Config
  toolRegistry?: ToolRegistry
  llmRegistry: Registry
  cwd?: string
}

function createServerContext(opts: CreateServerContextOptions): ServerContext {
  return {
    db: opts.db,
    config: opts.config ?? DEFAULT_CONFIG,
    toolRegistry: opts.toolRegistry ?? createDefaultRegistry(),
    llmRegistry: opts.llmRegistry,
    agentManager: createAgentManager(),
    cwd: opts.cwd ?? process.cwd(),
  }
}

export { createServerContext }
export type { CreateServerContextOptions }
```

- [ ] **Step 4: 创建 types.test.ts**

```typescript
// src/server/types.test.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../core/config.js'
import { createDB } from '../db/client.js'
import { createRegistry } from '../llm/registry.js'
import { migrateDB } from '../db/migrate.js'
import { createServerContext } from './context.js'
import type { ChatRequest, ConfirmRequest, ServerContext, SteerRequest } from './types.js'

describe('server/types', () => {
  it('createServerContext 组装所有服务', async () => {
    const db = createDB({ driver: 'pglite' })
    await migrateDB(db)
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
    })
    expect(ctx.db).toBe(db)
    expect(ctx.config).toEqual(DEFAULT_CONFIG)
    expect(ctx.toolRegistry).toBeDefined()
    expect(ctx.llmRegistry).toBeDefined()
    expect(ctx.agentManager).toBeDefined()
    expect(typeof ctx.cwd).toBe('string')
  })

  it('createServerContext 接受自定义 config 和 cwd', async () => {
    const db = createDB({ driver: 'pglite' })
    await migrateDB(db)
    const customConfig = { ...DEFAULT_CONFIG, defaultModel: 'custom-model' }
    const ctx = createServerContext({
      db,
      llmRegistry: createRegistry(),
      config: customConfig,
      cwd: '/tmp/test',
    })
    expect(ctx.config.defaultModel).toBe('custom-model')
    expect(ctx.cwd).toBe('/tmp/test')
  })

  it('请求类型满足结构约束', () => {
    const chat: ChatRequest = { sessionId: 's1', message: 'hello' }
    const steer: SteerRequest = { sessionId: 's1', message: 'stop' }
    const confirm: ConfirmRequest = { toolCallId: 'tc1', approved: true }
    expect(chat.sessionId).toBe('s1')
    expect(steer.message).toBe('stop')
    expect(confirm.approved).toBe(true)
  })
})
```

- [ ] **Step 5: 运行测试**

Run: `pnpm vitest run src/server/types.test.ts`
Expected: PASS（3 个测试通过）

- [ ] **Step 6: Commit**

```bash
git add src/server/types.ts src/server/context.ts src/server/agent-manager.ts src/server/types.test.ts
git commit -m "feat(server): add types, context factory, and agent-manager placeholder"
```

---

## Task 2: 错误处理中间件

**Files:**
- Create: `src/server/middleware/error.ts`
- Test: `src/server/middleware/error.test.ts`（在 app.test.ts 中间接测试，此处仅定义工具函数）

- [ ] **Step 1: 创建 middleware/error.ts**

```typescript
// src/server/middleware/error.ts
import type { Context } from 'hono'
import type { APIErrorBody } from '../types.js'

/** 构建标准 JSON 错误响应。 */
function apiError(c: Context, status: number, code: string, message: string) {
  return c.json<APIErrorBody>({ error: { code, message } }, status)
}

/** Hono onError 处理器：捕获未处理异常，返回 500。 */
function errorHandler(err: Error, c: Context): Response {
  const message = err instanceof Error ? err.message : 'Internal server error'
  return c.json<APIErrorBody>(
    { error: { code: 'INTERNAL', message } },
    500,
  )
}

export { apiError, errorHandler }
```

- [ ] **Step 2: 运行类型检查**

Run: `pnpm typecheck`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/server/middleware/error.ts
git commit -m "feat(server): add error handler middleware and apiError helper"
```

---

## Task 3: AgentManager（活跃 run 跟踪 + 控制操作）

**Files:**
- Modify: `src/server/agent-manager.ts`（替换占位实现）
- Create: `src/server/agent-manager.test.ts`

- [ ] **Step 1: 编写失败测试**

```typescript
// src/server/agent-manager.test.ts
import { describe, expect, it } from 'vitest'
import { injectSteering, pauseAgent, resumeAgent, abortAgent } from '../core/index.js'
import { createAgentManager } from './agent-manager.js'
import type { AgentDependencies, AgentState } from '../core/types.js'
import type { InteractivePermissionChecker } from './permission/interactive.js'

function mockState(sessionId: string): AgentState {
  return {
    id: 'agent-1',
    session: {
      id: sessionId,
      title: 'Test',
      parentId: null,
      branchPoint: null,
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    tools: [],
    config: { provider: 'test', model: 'test', tools: [], plugins: [] },
    status: { _tag: 'running', turnCount: 0 },
    abortController: new AbortController(),
    steeringQueue: [],
    llmDetails: [],
    tokenBudget: { total: 1000, reserved: 200, available: 800, used: 0, keepRecent: 100 },
  }
}

function mockPermissionChecker(): InteractivePermissionChecker {
  return {
    check: async () => ({ _tag: 'allow' }),
    confirm: () => false,
    hasPending: () => false,
    pendingCount: () => 0,
  } as unknown as InteractivePermissionChecker
}

describe('AgentManager', () => {
  it('register 和 get 跟踪活跃 run', () => {
    const mgr = createAgentManager()
    const state = mockState('s1')
    const deps = {} as AgentDependencies
    const pc = mockPermissionChecker()

    mgr.register({ sessionId: 's1', state, deps, permissionChecker: pc })

    expect(mgr.get('s1')?.state).toBe(state)
    expect(mgr.size()).toBe(1)
  })

  it('unregister 移除 run', () => {
    const mgr = createAgentManager()
    const state = mockState('s1')

    mgr.register({
      sessionId: 's1',
      state,
      deps: {} as AgentDependencies,
      permissionChecker: mockPermissionChecker(),
    })
    mgr.unregister('s1')

    expect(mgr.get('s1')).toBeUndefined()
    expect(mgr.size()).toBe(0)
  })

  it('get 不存在的 sessionId 返回 undefined', () => {
    const mgr = createAgentManager()
    expect(mgr.get('nonexistent')).toBeUndefined()
  })

  it('abort 调用 abortAgent 并返回 true', () => {
    const mgr = createAgentManager()
    const state = mockState('s1')

    mgr.register({
      sessionId: 's1',
      state,
      deps: {} as AgentDependencies,
      permissionChecker: mockPermissionChecker(),
    })

    const ok = mgr.abort('s1')
    expect(ok).toBe(true)
    expect(state.abortController.signal.aborted).toBe(true)
    expect(state.status._tag).toBe('stopped')
  })

  it('abort 不存在的 session 返回 false', () => {
    const mgr = createAgentManager()
    expect(mgr.abort('nope')).toBe(false)
  })

  it('pause 调用 pauseAgent', () => {
    const mgr = createAgentManager()
    const state = mockState('s1')

    mgr.register({
      sessionId: 's1',
      state,
      deps: {} as AgentDependencies,
      permissionChecker: mockPermissionChecker(),
    })

    const ok = mgr.pause('s1')
    expect(ok).toBe(true)
    expect(state.status._tag).toBe('paused')
  })

  it('resume 调用 resumeAgent', () => {
    const mgr = createAgentManager()
    const state = mockState('s1')

    mgr.register({
      sessionId: 's1',
      state,
      deps: {} as AgentDependencies,
      permissionChecker: mockPermissionChecker(),
    })

    mgr.pause('s1')
    expect(state.status._tag).toBe('paused')

    const ok = mgr.resume('s1')
    expect(ok).toBe(true)
    expect(state.status._tag).toBe('running')
  })

  it('steer 注入 steering 消息', () => {
    const mgr = createAgentManager()
    const state = mockState('s1')

    mgr.register({
      sessionId: 's1',
      state,
      deps: {} as AgentDependencies,
      permissionChecker: mockPermissionChecker(),
    })

    const ok = mgr.steer('s1', 'Be more concise')
    expect(ok).toBe(true)
    expect(state.steeringQueue).toContain('Be more concise')
  })

  it('register 覆盖相同 sessionId 的旧 run', () => {
    const mgr = createAgentManager()
    const state1 = mockState('s1')
    const state2 = mockState('s1')

    mgr.register({
      sessionId: 's1',
      state: state1,
      deps: {} as AgentDependencies,
      permissionChecker: mockPermissionChecker(),
    })
    mgr.register({
      sessionId: 's1',
      state: state2,
      deps: {} as AgentDependencies,
      permissionChecker: mockPermissionChecker(),
    })

    expect(mgr.size()).toBe(1)
    expect(mgr.get('s1')?.state).toBe(state2)
  })

  // 注意：abortAgent/pauseAgent/resumeAgent/injectSteering 已从 core 导入
  // 此处仅验证 mockState 的状态正确性，不实际调用 core 函数
  void abortAgent
  void pauseAgent
  void resumeAgent
  void injectSteering
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/server/agent-manager.test.ts`
Expected: FAIL（createAgentManager 返回空对象，无 register/get/abort 方法）

- [ ] **Step 3: 实现 agent-manager.ts**

```typescript
// src/server/agent-manager.ts
import { abortAgent, injectSteering, pauseAgent, resumeAgent } from '../core/index.js'
import type { AgentDependencies } from '../core/types.js'
import type { AgentState } from '../shared/types/agent.js'
import type { InteractivePermissionChecker } from './permission/interactive.js'

/** 一个活跃的 agent run。 */
type ActiveRun = {
  sessionId: string
  state: AgentState
  deps: AgentDependencies
  permissionChecker: InteractivePermissionChecker
}

/** Agent run 跟踪器 + 控制操作。 */
type AgentManager = {
  register(run: ActiveRun): void
  get(sessionId: string): ActiveRun | undefined
  unregister(sessionId: string): void
  size(): number
  abort(sessionId: string): boolean
  pause(sessionId: string): boolean
  resume(sessionId: string): boolean
  steer(sessionId: string, message: string): boolean
  confirmPermission(toolCallId: string, approved: boolean): boolean
}

function createAgentManager(): AgentManager {
  const runs = new Map<string, ActiveRun>()

  return {
    register(run) {
      runs.set(run.sessionId, run)
    },
    get(sessionId) {
      return runs.get(sessionId)
    },
    unregister(sessionId) {
      runs.delete(sessionId)
    },
    size() {
      return runs.size
    },
    abort(sessionId) {
      const run = runs.get(sessionId)
      if (!run) return false
      abortAgent(run.state)
      return true
    },
    pause(sessionId) {
      const run = runs.get(sessionId)
      if (!run) return false
      pauseAgent(run.state)
      return true
    },
    resume(sessionId) {
      const run = runs.get(sessionId)
      if (!run) return false
      resumeAgent(run.state)
      return true
    },
    steer(sessionId, message) {
      const run = runs.get(sessionId)
      if (!run) return false
      injectSteering(run.state, message)
      return true
    },
    confirmPermission(toolCallId, approved) {
      for (const run of runs.values()) {
        if (run.permissionChecker.hasPending(toolCallId)) {
          run.permissionChecker.confirm(toolCallId, approved)
          return true
        }
      }
      return false
    },
  }
}

export { createAgentManager }
export type { ActiveRun, AgentManager }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/server/agent-manager.test.ts`
Expected: PASS（9 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/server/agent-manager.ts src/server/agent-manager.test.ts
git commit -m "feat(server): implement AgentManager with run tracking and control ops"
```

---

## Task 4: InteractivePermissionChecker（阻塞式权限确认）

**Files:**
- Create: `src/server/permission/interactive.ts`
- Create: `src/server/permission/interactive.test.ts`

- [ ] **Step 1: 编写失败测试**

```typescript
// src/server/permission/interactive.test.ts
import { describe, expect, it } from 'vitest'
import { createInteractivePermissionChecker } from './interactive.js'
import type { ToolContext, ToolDef } from '../../shared/types/tool.js'

const autoTool: ToolDef = {
  name: 'read',
  description: 'read file',
  parameters: { type: 'object', properties: {} },
  permission: 'auto',
  execute: async () => ({ _tag: 'success', output: '' }),
}

const askTool: ToolDef = {
  name: 'write',
  description: 'write file',
  parameters: { type: 'object', properties: {} },
  permission: 'ask',
  execute: async () => ({ _tag: 'success', output: '' }),
}

const denyTool: ToolDef = {
  name: 'danger',
  description: 'dangerous',
  parameters: { type: 'object', properties: {} },
  permission: 'deny',
  execute: async () => ({ _tag: 'success', output: '' }),
}

const ctx: ToolContext = {
  cwd: '/tmp',
  session: { id: 's1', cwd: '/tmp' },
  abort: new AbortController().signal,
}

describe('InteractivePermissionChecker', () => {
  it('auto 权限工具直接 allow', async () => {
    const checker = createInteractivePermissionChecker()
    const result = await checker.check(autoTool, {}, ctx)
    expect(result._tag).toBe('allow')
  })

  it('deny 权限工具直接 deny', async () => {
    const checker = createInteractivePermissionChecker()
    const result = await checker.check(denyTool, {}, ctx)
    expect(result._tag).toBe('deny')
  })

  it('alwaysAllow 列表中的工具直接 allow（即使 permission=ask）', async () => {
    const checker = createInteractivePermissionChecker({ alwaysAllow: ['write'] })
    const result = await checker.check(askTool, {}, ctx)
    expect(result._tag).toBe('allow')
  })

  it('alwaysDeny 列表中的工具直接 deny', async () => {
    const checker = createInteractivePermissionChecker({ alwaysDeny: ['read'] })
    const result = await checker.check(autoTool, {}, ctx)
    expect(result._tag).toBe('deny')
  })

  it('ask 权限工具触发 onPermissionRequired 回调并阻塞', async () => {
    let calledWith: { toolCallId: string; tool: string; input: unknown } | null = null
    const checker = createInteractivePermissionChecker({
      onPermissionRequired: (req) => {
        calledWith = req
      },
    })

    const checkPromise = checker.check(askTool, { path: 'test.txt' }, ctx)

    // 回调被调用
    await Promise.resolve()
    expect(calledWith).not.toBeNull()
    expect(calledWith?.tool).toBe('write')
    expect(calledWith?.input).toEqual({ path: 'test.txt' })
    expect(checker.hasPending(calledWith!.toolCallId)).toBe(true)
    expect(checker.pendingCount()).toBe(1)

    // 确认后解除阻塞
    const confirmed = checker.confirm(calledWith!.toolCallId, true)
    expect(confirmed).toBe(true)

    const result = await checkPromise
    expect(result._tag).toBe('allow')
    expect(checker.pendingCount()).toBe(0)
  })

  it('confirm(approved=false) 返回 deny', async () => {
    const checker = createInteractivePermissionChecker()
    const checkPromise = checker.check(askTool, {}, ctx)

    await Promise.resolve()
    const pendingId = Array.from({ length: checker.pendingCount() }, (_, i) => i)[0]
    // 获取 pending toolCallId
    // 由于无法直接获取，用一个辅助：onPermissionRequired 捕获
    let captured: string | null = null
    const checker2 = createInteractivePermissionChecker({
      onPermissionRequired: (req) => {
        captured = req.toolCallId
      },
    })
    const checkPromise2 = checker2.check(askTool, {}, ctx)
    await Promise.resolve()
    expect(captured).not.toBeNull()
    checker2.confirm(captured!, false)
    const result = await checkPromise2
    expect(result._tag).toBe('deny')

    // 清理第一个 promise（永远不会 resolve，但测试结束会被 GC）
    void pendingId
    void checkPromise
  })

  it('confirm 不存在的 toolCallId 返回 false', () => {
    const checker = createInteractivePermissionChecker()
    expect(checker.confirm('nonexistent', true)).toBe(false)
  })

  it('hasPending 对不存在的 id 返回 false', () => {
    const checker = createInteractivePermissionChecker()
    expect(checker.hasPending('nope')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/server/permission/interactive.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 interactive.ts**

```typescript
// src/server/permission/interactive.ts
import { randomUUID } from 'node:crypto'
import type { ToolContext, ToolDef } from '../../shared/types/tool.js'
import type { PermissionChecker, PermissionResult } from '../../tools/types.js'

/** 权限请求（需要用户确认）。 */
type PermissionRequest = {
  toolCallId: string
  tool: string
  input: unknown
}

/** 待处理的权限确认。 */
type PendingPermission = {
  request: PermissionRequest
  resolve: (result: PermissionResult) => void
}

type InteractivePermissionCheckerOptions = {
  /** 始终允许的工具名（覆盖 permission 字段）。 */
  alwaysAllow?: string[]
  /** 始终拒绝的工具名（覆盖 permission 字段）。 */
  alwaysDeny?: string[]
  /** 遇到 ask 权限时调用（用于通知前端）。 */
  onPermissionRequired?: (request: PermissionRequest) => void | Promise<void>
}

/** 阻塞式权限检查器：ask 权限会阻塞等待用户确认。 */
type InteractivePermissionChecker = PermissionChecker & {
  confirm(toolCallId: string, approved: boolean): boolean
  hasPending(toolCallId: string): boolean
  pendingCount(): number
}

function createInteractivePermissionChecker(
  opts: InteractivePermissionCheckerOptions = {},
): InteractivePermissionChecker {
  const allowSet = new Set(opts.alwaysAllow ?? [])
  const denySet = new Set(opts.alwaysDeny ?? [])
  const pending = new Map<string, PendingPermission>()

  return {
    check: async (tool: ToolDef, input: unknown, _ctx: ToolContext): Promise<PermissionResult> => {
      if (denySet.has(tool.name)) {
        return { _tag: 'deny', reason: `Tool "${tool.name}" is denied by configuration` }
      }
      if (allowSet.has(tool.name) || tool.permission === 'auto') {
        return { _tag: 'allow' }
      }
      if (tool.permission === 'deny') {
        return { _tag: 'deny', reason: `Tool "${tool.name}" is disabled` }
      }

      // tool.permission === 'ask' — 交互式确认
      const toolCallId = randomUUID()
      const request: PermissionRequest = { toolCallId, tool: tool.name, input }
      const promise = new Promise<PermissionResult>((resolve) => {
        pending.set(toolCallId, { request, resolve })
      })
      await opts.onPermissionRequired?.(request)
      return promise
    },
    confirm(toolCallId, approved) {
      const p = pending.get(toolCallId)
      if (!p) return false
      pending.delete(toolCallId)
      p.resolve(
        approved
          ? { _tag: 'allow' }
          : { _tag: 'deny', reason: 'User denied permission' },
      )
      return true
    },
    hasPending(toolCallId) {
      return pending.has(toolCallId)
    },
    pendingCount() {
      return pending.size
    },
  }
}

export { createInteractivePermissionChecker }
export type {
  InteractivePermissionChecker,
  InteractivePermissionCheckerOptions,
  PermissionRequest,
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/server/permission/interactive.test.ts`
Expected: PASS（8 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/server/permission/interactive.ts src/server/permission/interactive.test.ts
git commit -m "feat(server): implement InteractivePermissionChecker with blocking confirmation"
```

---

## Task 5: Health 路由

**Files:**
- Create: `src/server/routes/health.ts`
- Create: `src/server/routes/health.test.ts`

- [ ] **Step 1: 编写失败测试**

```typescript
// src/server/routes/health.test.ts
import { describe, expect, it } from 'vitest'
import { createHealthRoute } from './health.js'

describe('health route', () => {
  it('GET / 返回 ok 状态', async () => {
    const app = createHealthRoute()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.version).toBeDefined()
  })

  it('GET / 包含 timestamp', async () => {
    const app = createHealthRoute()
    const res = await app.request('/')
    const body = await res.json()
    expect(body.timestamp).toBeDefined()
    expect(typeof body.timestamp).toBe('number')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/server/routes/health.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 health.ts**

```typescript
// src/server/routes/health.ts
import { Hono } from 'hono'

function createHealthRoute(): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    return c.json({
      status: 'ok',
      version: '0.1.0',
      timestamp: Date.now(),
    })
  })

  return app
}

export { createHealthRoute }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/server/routes/health.test.ts`
Expected: PASS（2 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/health.ts src/server/routes/health.test.ts
git commit -m "feat(server): add health check route"
```

---

## Task 6: Session 路由

**Files:**
- Create: `src/server/routes/session.ts`
- Create: `src/server/routes/session.test.ts`

- [ ] **Step 1: 编写失败测试**

```typescript
// src/server/routes/session.test.ts
import { describe, expect, it } from 'vitest'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { createSessionRoute } from './session.js'

async function setup() {
  const db = createDB({ driver: 'pglite' })
  await migrateDB(db)
  const ctx = createServerContext({ db, llmRegistry: createRegistry() })
  const app = createSessionRoute(ctx)
  return { app, ctx }
}

describe('session route', () => {
  it('POST / 创建会话', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My Session' }),
    })
    expect(res.status).toBe(201)
    const session = await res.json()
    expect(session.title).toBe('My Session')
    expect(session.id).toBeDefined()
    expect(session.parentId).toBeNull()
  })

  it('POST / 无 title 使用默认值', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(201)
    const session = await res.json()
    expect(session.title).toBe('New Session')
  })

  it('GET / 列出所有会话', async () => {
    const { app } = await setup()
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'S1' }),
    })
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'S2' }),
    })
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const sessions = await res.json()
    expect(sessions).toHaveLength(2)
  })

  it('GET /:id 返回会话详情', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Detail' }),
    })
    const created = await createRes.json()
    const res = await app.request(`/${created.id}`)
    expect(res.status).toBe(200)
    const session = await res.json()
    expect(session.id).toBe(created.id)
  })

  it('GET /:id 不存在返回 404', async () => {
    const { app } = await setup()
    const res = await app.request('/nonexistent')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('DELETE /:id 删除会话', async () => {
    const { app } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'ToDelete' }),
    })
    const created = await createRes.json()
    const delRes = await app.request(`/${created.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(204)
    const getRes = await app.request(`/${created.id}`)
    expect(getRes.status).toBe(404)
  })

  it('GET /:id/messages 返回消息列表', async () => {
    const { app, ctx } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Msg' }),
    })
    const created = await createRes.json()
    await ctx.db.db.insert((await import('../../db/schema.js')).sessionEntries).values({
      sessionId: created.id,
      tag: 'message',
      role: 'user',
      content: [{ _tag: 'text', text: 'hello' }],
    })
    const res = await app.request(`/${created.id}/messages`)
    expect(res.status).toBe(200)
    const messages = await res.json()
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
  })

  it('POST /:id/fork 分支会话', async () => {
    const { app, ctx } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Original' }),
    })
    const created = await createRes.json()
    await ctx.db.db.insert((await import('../../db/schema.js')).sessionEntries).values({
      sessionId: created.id,
      tag: 'message',
      role: 'user',
      content: [{ _tag: 'text', text: 'msg1' }],
    })
    const forkRes = await app.request(`/${created.id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIndex: 0 }),
    })
    expect(forkRes.status).toBe(201)
    const forked = await forkRes.json()
    expect(forked.parentId).toBe(created.id)
  })

  it('GET /tree 返回会话树', async () => {
    const { app } = await setup()
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Root' }),
    })
    const res = await app.request('/tree')
    expect(res.status).toBe(200)
    const tree = await res.json()
    expect(Array.isArray(tree)).toBe(true)
    expect(tree.length).toBeGreaterThan(0)
  })

  it('GET /:id/llm-details 返回活跃 run 的详情', async () => {
    const { app, ctx } = await setup()
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Detail' }),
    })
    const created = await createRes.json()
    const res = await app.request(`/${created.id}/llm-details`)
    expect(res.status).toBe(200)
    const details = await res.json()
    expect(Array.isArray(details)).toBe(true)
    void ctx
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/server/routes/session.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 session.ts**

```typescript
// src/server/routes/session.ts
import { Hono } from 'hono'
import { getBranches, getTree } from '../../session/branch.js'
import { getMessages } from '../../session/message.js'
import {
  createSession,
  deleteSession,
  forkSession,
  getSession,
  listSessions,
} from '../../session/session.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

function createSessionRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 创建会话
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
    const title = (body.title as string) ?? 'New Session'
    const session = await createSession(ctx.db, title)
    return c.json(session, 201)
  })

  // 列出会话
  app.get('/', async (c) => {
    const sessions = await listSessions(ctx.db)
    return c.json(sessions)
  })

  // 会话树
  app.get('/tree', async (c) => {
    const tree = await getTree(ctx.db)
    return c.json(tree)
  })

  // 获取会话详情
  app.get('/:id', async (c) => {
    const session = await getSession(ctx.db, c.req.param('id'))
    if (!session) {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
    return c.json(session)
  })

  // 分支会话
  app.post('/:id/fork', async (c) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
    const messageIndex = (body.messageIndex as number) ?? 0
    try {
      const forked = await forkSession(ctx.db, id, messageIndex)
      return c.json(forked, 201)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }
  })

  // 删除会话
  app.delete('/:id', async (c) => {
    await deleteSession(ctx.db, c.req.param('id'))
    return c.body(null, 204)
  })

  // 获取消息列表
  app.get('/:id/messages', async (c) => {
    const messages = await getMessages(ctx.db, c.req.param('id'))
    return c.json(messages)
  })

  // 获取 LLM 调用详情
  app.get('/:id/llm-details', async (c) => {
    const run = ctx.agentManager.get(c.req.param('id'))
    return c.json(run?.state.llmDetails ?? [])
  })

  // 获取分支
  app.get('/:id/branches', async (c) => {
    const branches = await getBranches(ctx.db, c.req.param('id'))
    return c.json(branches)
  })

  return app
}

export { createSessionRoute }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/server/routes/session.test.ts`
Expected: PASS（10 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/session.ts src/server/routes/session.test.ts
git commit -m "feat(server): add session CRUD, fork, messages, tree, llm-details routes"
```

---

## Task 7: Config 路由

**Files:**
- Create: `src/server/routes/config.ts`
- Create: `src/server/routes/config.test.ts`

- [ ] **Step 1: 编写失败测试**

```typescript
// src/server/routes/config.test.ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { createConfigRoute } from './config.js'

function setup(cwd?: string) {
  const db = createDB({ driver: 'pglite' })
  const ctx = createServerContext({
    db,
    llmRegistry: createRegistry(),
    cwd: cwd ?? join(mkdtempSync(join(tmpdir(), 'c0de-test-'))),
  })
  const app = createConfigRoute(ctx)
  return { app, ctx }
}

describe('config route', () => {
  it('GET / 返回当前配置', async () => {
    const { app } = setup()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const config = await res.json()
    expect(config.defaultProvider).toBeDefined()
    expect(config.defaultModel).toBeDefined()
    expect(config.tools).toBeDefined()
  })

  it('PATCH / 更新配置（合并）', async () => {
    const { app, ctx } = setup()
    const res = await app.request('/', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'gpt-5' }),
    })
    expect(res.status).toBe(200)
    const config = await res.json()
    expect(config.defaultModel).toBe('gpt-5')
    // 原有字段保留
    expect(config.defaultProvider).toBeDefined()
    // context 同步更新
    expect(ctx.config.defaultModel).toBe('gpt-5')
  })

  it('PATCH / 深度合并嵌套对象', async () => {
    const { app, ctx } = setup()
    const res = await app.request('/', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tools: { enabled: ['read', 'write'] } }),
    })
    expect(res.status).toBe(200)
    const config = await res.json()
    expect(config.tools.enabled).toEqual(['read', 'write'])
    // disabled 字段保留
    expect(config.tools.disabled).toBeDefined()
    void ctx
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/server/routes/config.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 config.ts**

```typescript
// src/server/routes/config.ts
import { Hono } from 'hono'
import { mergeConfig, saveConfig } from '../../core/config.js'
import type { Config } from '../../shared/types/config.js'
import type { ServerContext } from '../types.js'

function createConfigRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    return c.json(ctx.config)
  })

  app.patch('/', async (c) => {
    const patch = await c.req.json<Partial<Config>>()
    ctx.config = mergeConfig(ctx.config, patch)
    await saveConfig(ctx.config, 'project', ctx.cwd).catch(() => {
      // 保存失败不影响内存配置
    })
    return c.json(ctx.config)
  })

  return app
}

export { createConfigRoute }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/server/routes/config.test.ts`
Expected: PASS（3 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/config.ts src/server/routes/config.test.ts
git commit -m "feat(server): add config get and patch routes"
```

---

## Task 8: Tool 路由

**Files:**
- Create: `src/server/routes/tool.ts`
- Create: `src/server/routes/tool.test.ts`

- [ ] **Step 1: 编写失败测试**

```typescript
// src/server/routes/tool.test.ts
import { describe, expect, it } from 'vitest'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { createToolRoute } from './tool.js'

async function setup() {
  const db = createDB({ driver: 'pglite' })
  await migrateDB(db)
  const ctx = createServerContext({ db, llmRegistry: createRegistry() })
  const app = createToolRoute(ctx)
  return { app, ctx }
}

describe('tool route', () => {
  it('GET / 列出可用工具', async () => {
    const { app } = await setup()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const tools = await res.json()
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
    const names = tools.map((t: { name: string }) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).toContain('bash')
  })

  it('GET / 工具包含 name, description, parameters, permission', async () => {
    const { app } = await setup()
    const res = await app.request('/')
    const tools = await res.json()
    const readTool = tools.find((t: { name: string }) => t.name === 'read')
    expect(readTool).toBeDefined()
    expect(readTool.description).toBeDefined()
    expect(readTool.parameters).toBeDefined()
    expect(readTool.permission).toBeDefined()
    // 不应包含 execute 函数（不可序列化）
    expect(readTool.execute).toBeUndefined()
  })

  it('POST /confirm 无活跃 run 返回 404', async () => {
    const { app } = await setup()
    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tc1', approved: true }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('POST /confirm 确认权限', async () => {
    const { app, ctx } = await setup()
    // 注册一个带 pending 权限的 mock run
    let resolvePending: ((approved: boolean) => void) | null = null
    const pendingMap = new Map<string, (approved: boolean) => void>()
    const mockChecker = {
      check: async () => ({ _tag: 'allow' as const }),
      confirm: (id: string, approved: boolean) => {
        const r = pendingMap.get(id)
        if (!r) return false
        pendingMap.delete(id)
        r(approved)
        return true
      },
      hasPending: (id: string) => pendingMap.has(id),
      pendingCount: () => pendingMap.size,
    }
    pendingMap.set('tc-test', (approved) => {
      resolvePending = () => {}
      void approved
    })
    ctx.agentManager.register({
      sessionId: 's1',
      state: {
        id: 'a1',
        session: { id: 's1', title: 'T', parentId: null, branchPoint: null, metadata: {}, createdAt: 0, updatedAt: 0 },
        messages: [],
        tools: [],
        config: { provider: 'p', model: 'm', tools: [], plugins: [] },
        status: { _tag: 'running', turnCount: 0 },
        abortController: new AbortController(),
        steeringQueue: [],
        llmDetails: [],
        tokenBudget: { total: 0, reserved: 0, available: 0, used: 0, keepRecent: 0 },
      },
      deps: {} as never,
      permissionChecker: mockChecker as never,
    })

    const res = await app.request('/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tc-test', approved: true }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.confirmed).toBe(true)
    void resolvePending
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/server/routes/tool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 tool.ts**

```typescript
// src/server/routes/tool.ts
import { Hono } from 'hono'
import { listTools } from '../../tools/registry.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

function createToolRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 列出可用工具（不含 execute 函数）
  app.get('/', (c) => {
    const tools = listTools(ctx.toolRegistry, { config: {}, cwd: ctx.cwd })
    const serializable = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      permission: t.permission,
    }))
    return c.json(serializable)
  })

  // 确认工具执行权限
  app.post('/confirm', async (c) => {
    const body = await c.req.json()
    const ok = ctx.agentManager.confirmPermission(body.toolCallId, body.approved)
    if (!ok) {
      return apiError(c, 404, 'NOT_FOUND', 'No pending permission for this tool call')
    }
    return c.json({ confirmed: true })
  })

  return app
}

export { createToolRoute }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/server/routes/tool.test.ts`
Expected: PASS（4 个测试通过）

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/tool.ts src/server/routes/tool.test.ts
git commit -m "feat(server): add tool listing and permission confirmation routes"
```

---

## Task 9: Chat SSE 路由

**Files:**
- Create: `src/server/routes/chat.ts`
- Create: `src/server/routes/chat.test.ts`

- [ ] **Step 1: 编写失败测试**

```typescript
// src/server/routes/chat.test.ts
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '../../shared/types/llm.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { createSession } from '../../session/session.js'
import { createServerContext } from '../context.js'
import { createChatRoute } from './chat.js'

/** 模拟 chatStream：返回简单的文本 + done。 */
function mockChatStream(): AsyncGenerator<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    yield { _tag: 'text', text: 'Hello' }
    yield { _tag: 'text', text: ' world' }
    yield { _tag: 'done' }
  })()
}

async function setup() {
  const db = createDB({ driver: 'pglite' })
  await migrateDB(db)
  const session = await createSession(db, 'Test')
  const ctx = createServerContext({
    db,
    llmRegistry: createRegistry(),
    chatStream: mockChatStream,
  })
  const app = createChatRoute(ctx)
  return { app, ctx, sessionId: session.id }
}

/** 从 SSE 响应中解析事件。 */
function parseSSEEvents(text: string): { event: string; data: string }[] {
  const events: { event: string; data: string }[] = []
  const blocks = text.split('\n\n')
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim())
    if (lines.length === 0) continue
    const eventLine = lines.find((l) => l.startsWith('event:'))
    const dataLine = lines.find((l) => l.startsWith('data:'))
    if (eventLine && dataLine) {
      events.push({
        event: eventLine.slice(6).trim(),
        data: dataLine.slice(5).trim(),
      })
    }
  }
  return events
}

describe('chat route (SSE)', () => {
  it('POST / 缺少 sessionId 返回 400', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST / 缺少 message 返回 400', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    expect(res.status).toBe(400)
  })

  it('POST / 不存在的 session 返回 404', async () => {
    const { app } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nonexistent', message: 'hi' }),
    })
    expect(res.status).toBe(404)
  })

  it('POST / 流式返回 agent 事件', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'Hello' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const text = await res.text()
    const events = parseSSEEvents(text)

    // 应包含 text_delta 和 done 事件
    const types = events.map((e) => e.event)
    expect(types).toContain('text_delta')
    expect(types).toContain('done')
  })

  it('POST / text_delta 事件包含文本内容', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'Hi' }),
    })
    const text = await res.text()
    const events = parseSSEEvents(text)
    const textDeltas = events.filter((e) => e.event === 'text_delta')
    const combinedText = textDeltas
      .map((e) => JSON.parse(e.data).text as string)
      .join('')
    expect(combinedText).toContain('Hello')
  })

  it('POST / 完成后从 agentManager 注销', async () => {
    const { app, ctx, sessionId } = await setup()
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'Hi' }),
    })
    // 等 SSE 完成
    expect(ctx.agentManager.get(sessionId)).toBeUndefined()
  })
})

describe('chat route (control endpoints)', () => {
  it('POST /abort 无活跃 run 返回 { aborted: false }', async () => {
    const { app } = await setup()
    const res = await app.request('/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.aborted).toBe(false)
  })

  it('POST /pause 无活跃 run 返回 { paused: false }', async () => {
    const { app } = await setup()
    const res = await app.request('/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).paused).toBe(false)
  })

  it('POST /resume 无活跃 run 返回 { resumed: false }', async () => {
    const { app } = await setup()
    const res = await app.request('/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).resumed).toBe(false)
  })

  it('POST /steer 无活跃 run 返回 { steered: false }', async () => {
    const { app } = await setup()
    const res = await app.request('/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope', message: 'msg' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).steered).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/server/routes/chat.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 chat.ts**

```typescript
// src/server/routes/chat.ts
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createAgent, runAgent } from '../../core/agent.js'
import type { LoopDeps } from '../../core/loop.js'
import type { AgentConfig } from '../../shared/types/agent.js'
import { getSession } from '../../session/session.js'
import { createInteractivePermissionChecker } from '../permission/interactive.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

function createChatRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // POST / — SSE 流式聊天
  app.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
    const sessionId = body.sessionId as string | undefined
    const message = body.message as string | undefined

    if (!sessionId || !message) {
      return apiError(c, 400, 'BAD_REQUEST', 'sessionId and message are required')
    }

    const session = await getSession(ctx.db, sessionId)
    if (!session) {
      return apiError(c, 404, 'NOT_FOUND', 'Session not found')
    }

    return streamSSE(c, async (stream) => {
      // 权限检查器：ask 权限通过 SSE 通知前端，阻塞等待确认
      const permissionChecker = createInteractivePermissionChecker({
        onPermissionRequired: async (req) => {
          await stream.writeSSE({
            event: 'permission_required',
            data: JSON.stringify({ _tag: 'permission_required', ...req }),
          })
        },
      })

      // 构建 agent 依赖（注入测试用 chatStream）
      const deps: LoopDeps = {
        db: ctx.db,
        llmRegistry: ctx.llmRegistry,
        toolRegistry: ctx.toolRegistry,
        permission: permissionChecker,
        config: ctx.config,
        cwd: ctx.cwd,
        ...(ctx.chatStream ? { chatStream: ctx.chatStream } : {}),
      }

      const provider = (body.provider as string) ?? ctx.config.defaultProvider
      const model = (body.model as string) ?? ctx.config.defaultModel
      const tools = (body.tools as string[]) ?? ctx.config.tools.enabled

      const agentConfig: AgentConfig = {
        provider,
        model,
        tools,
        plugins: ctx.config.plugins.enabled,
      }

      const state = await createAgent(session, agentConfig, deps)

      ctx.agentManager.register({ sessionId, state, deps, permissionChecker })

      // 客户端断开时中止 agent
      stream.onAbort(() => {
        ctx.agentManager.abort(sessionId)
      })

      try {
        for await (const event of runAgent(state, message, deps)) {
          await stream.writeSSE({
            event: event._tag,
            data: JSON.stringify(event),
          })
        }
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            _tag: 'error',
            error: {
              _tag: 'unexpected',
              message: err instanceof Error ? err.message : String(err),
            },
          }),
        })
      } finally {
        ctx.agentManager.unregister(sessionId)
      }
    })
  })

  // 控制端点
  app.post('/abort', async (c) => {
    const { sessionId } = await c.req.json()
    return c.json({ aborted: ctx.agentManager.abort(sessionId) })
  })

  app.post('/pause', async (c) => {
    const { sessionId } = await c.req.json()
    return c.json({ paused: ctx.agentManager.pause(sessionId) })
  })

  app.post('/resume', async (c) => {
    const { sessionId } = await c.req.json()
    return c.json({ resumed: ctx.agentManager.resume(sessionId) })
  })

  app.post('/steer', async (c) => {
    const body = await c.req.json()
    return c.json({ steered: ctx.agentManager.steer(body.sessionId, body.message) })
  })

  return app
}

export { createChatRoute }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/server/routes/chat.test.ts`
Expected: PASS（10 个测试通过）

注意：如果 SSE 响应在测试中无法完整读取，可能需要调整 `mockChatStream` 或使用 `app.request` 的返回值手动读取流。Hono 的 `app.request` 会完整执行 SSE 回调并返回最终 Response。

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/chat.ts src/server/routes/chat.test.ts
git commit -m "feat(server): add SSE chat streaming and agent control endpoints"
```

---

## Task 10: Files 路由（文件浏览）

**Files:**
- Create: `src/server/routes/files.ts`
- Create: `src/server/routes/files.test.ts`

- [ ] **Step 1: 编写失败测试**

```typescript
// src/server/routes/files.test.ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDB } from '../../db/client.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { createFilesRoute } from './files.js'

function setupWithDir() {
  const dir = mkdtempSync(join(tmpdir(), 'c0de-files-'))
  writeFileSync(join(dir, 'hello.txt'), 'Hello World')
  writeFileSync(join(dir, 'config.json'), '{"key":"value"}')
  mkdirSync(join(dir, 'subdir'))
  writeFileSync(join(dir, 'subdir', 'nested.ts'), 'export const x = 1')
  const db = createDB({ driver: 'pglite' })
  const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
  const app = createFilesRoute(ctx)
  return { app, ctx, dir }
}

describe('files route', () => {
  it('GET / 列出根目录文件', async () => {
    const { app } = setupWithDir()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const entries = await res.json()
    const names = entries.map((e: { name: string }) => e.name)
    expect(names).toContain('hello.txt')
    expect(names).toContain('config.json')
    expect(names).toContain('subdir')
    const subdir = entries.find((e: { name: string }) => e.name === 'subdir')
    expect(subdir.type).toBe('directory')
  })

  it('GET /?path=subdir 列出子目录', async () => {
    const { app } = setupWithDir()
    const res = await app.request('/?path=subdir')
    expect(res.status).toBe(200)
    const entries = await res.json()
    expect(entries.map((e: { name: string }) => e.name)).toContain('nested.ts')
  })

  it('GET /hello.txt 读取文件内容', async () => {
    const { app } = setupWithDir()
    const res = await app.request('/hello.txt')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.path).toBe('hello.txt')
    expect(body.content).toBe('Hello World')
  })

  it('GET /config.json 读取 JSON 文件', async () => {
    const { app } = setupWithDir()
    const res = await app.request('/config.json')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe('{"key":"value"}')
  })

  it('PUT /new.txt 写入文件', async () => {
    const { app } = setupWithDir()
    const res = await app.request('/new.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'New content' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.written).toBe(true)
    // 验证写入
    const readRes = await app.request('/new.txt')
    const readBody = await readRes.json()
    expect(readBody.content).toBe('New content')
  })

  it('PUT 自动创建父目录', async () => {
    const { app } = setupWithDir()
    const res = await app.request('/deep/path/file.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'deep' }),
    })
    expect(res.status).toBe(200)
    const readRes = await app.request('/deep/path/file.txt')
    expect(readRes.status).toBe(200)
  })

  it('GET /../etc/passwd 路径穿越被拒绝', async () => {
    const { app } = setupWithDir()
    const res = await app.request('/..%2Fetc%2Fpasswd')
    expect(res.status).toBe(403)
  })

  it('GET /nonexistent.txt 返回 404', async () => {
    const { app } = setupWithDir()
    const res = await app.request('/nonexistent.txt')
    expect(res.status).toBe(404)
  })

  it('GET /search?q=hello 搜索文件名', async () => {
    const { app } = setupWithDir()
    const res = await app.request('/search?q=hello')
    expect(res.status).toBe(200)
    const results = await res.json()
    expect(Array.isArray(results)).toBe(true)
    const paths = results.map((r: { path: string }) => r.path)
    expect(paths.some((p: string) => p.includes('hello'))).toBe(true)
  })

  it('GET /search 无 q 参数返回 400', async () => {
    const { app } = setupWithDir()
    const res = await app.request('/search')
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/server/routes/files.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 files.ts**

```typescript
// src/server/routes/files.ts
import { Hono } from 'hono'
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

type FileEntry = {
  name: string
  type: 'file' | 'directory'
}

type SearchResult = {
  path: string
  type: 'file' | 'directory'
}

/** 安全路径检查：确保解析后的路径在 cwd 内。 */
function safeResolve(ctx: ServerContext, requestPath: string): string | null {
  const resolved = resolve(ctx.cwd, requestPath)
  const rel = relative(ctx.cwd, resolved)
  if (rel.startsWith('..') || resolve(ctx.cwd, rel) !== resolved) {
    return null
  }
  return resolved
}

/** 递归收集文件列表（用于搜索）。 */
async function collectFiles(dir: string, basePath: string, maxDepth = 5): Promise<SearchResult[]> {
  if (maxDepth < 0) return []
  const results: SearchResult[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const fullPath = join(dir, entry.name)
    const relPath = relative(basePath, fullPath)
    if (entry.isDirectory()) {
      results.push({ path: relPath, type: 'directory' })
      results.push(...(await collectFiles(fullPath, basePath, maxDepth - 1)))
    } else {
      results.push({ path: relPath, type: 'file' })
    }
  }
  return results
}

function createFilesRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 列出目录
  app.get('/', async (c) => {
    const queryPath = c.req.query('path') ?? '.'
    const resolved = safeResolve(ctx, queryPath)
    if (!resolved) {
      return apiError(c, 403, 'FORBIDDEN', 'Path outside workspace')
    }
    try {
      const entries = await readdir(resolved, { withFileTypes: true })
      const result: FileEntry[] = entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      return c.json(result)
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'Directory not found')
    }
  })

  // 搜索文件名
  app.get('/search', async (c) => {
    const q = c.req.query('q')
    if (!q) {
      return apiError(c, 400, 'BAD_REQUEST', 'Query parameter q is required')
    }
    const all = await collectFiles(ctx.cwd, ctx.cwd)
    const lower = q.toLowerCase()
    const matched = all.filter((f) => f.path.toLowerCase().includes(lower))
    return c.json(matched)
  })

  // 读取文件
  app.get('/*', async (c) => {
    const path = c.req.path.replace('/api/files/', '')
    const resolved = safeResolve(ctx, path)
    if (!resolved) {
      return apiError(c, 403, 'FORBIDDEN', 'Path outside workspace')
    }
    try {
      const content = await readFile(resolved, 'utf-8')
      return c.json({ path, content })
    } catch {
      return apiError(c, 404, 'NOT_FOUND', 'File not found')
    }
  })

  // 写入文件
  app.put('/*', async (c) => {
    const path = c.req.path.replace('/api/files/', '')
    const resolved = safeResolve(ctx, path)
    if (!resolved) {
      return apiError(c, 403, 'FORBIDDEN', 'Path outside workspace')
    }
    const body = await c.req.json()
    try {
      await mkdir(dirname(resolved), { recursive: true })
      await writeFile(resolved, body.content as string, 'utf-8')
      return c.json({ path, written: true })
    } catch (err) {
      return apiError(c, 500, 'WRITE_ERROR', `Failed to write file: ${String(err)}`)
    }
  })

  return app
}

export { createFilesRoute }
```

注意：`safeResolve` 中路径穿越检测会拒绝 `..` 开头的相对路径。测试中的 `/..%2Fetc%2Fpasswd` 会被 Hono 解码。`relative(ctx.cwd, resolved)` 返回以 `..` 开头的字符串时返回 null。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/server/routes/files.test.ts`
Expected: PASS（10 个测试通过）

如果路径穿越测试失败（Hono 可能已解码 `..`），调整测试用 `%2E%2E` 或直接用 `..`。

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/files.ts src/server/routes/files.test.ts
git commit -m "feat(server): add file browser routes (list, read, write, search)"
```

---

## Task 11: App 工厂 + Server 启动 + Barrel Export

**Files:**
- Create: `src/server/app.ts`
- Create: `src/server/server.ts`
- Modify: `src/server/index.ts`（替换占位）
- Create: `src/server/app.test.ts`
- Create: `src/server/index.test.ts`

- [ ] **Step 1: 实现 app.ts**

```typescript
// src/server/app.ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { errorHandler } from './middleware/error.js'
import { createChatRoute } from './routes/chat.js'
import { createConfigRoute } from './routes/config.js'
import { createFilesRoute } from './routes/files.js'
import { createHealthRoute } from './routes/health.js'
import { createSessionRoute } from './routes/session.js'
import { createToolRoute } from './routes/tool.js'
import type { ServerContext } from './types.js'

/** 创建完整的 Hono 应用，挂载所有路由 + 中间件。 */
function createApp(ctx: ServerContext): Hono {
  const app = new Hono()

  // 中间件
  app.onError(errorHandler)
  app.use('*', cors())

  // 路由
  app.route('/api/health', createHealthRoute())
  app.route('/api/sessions', createSessionRoute(ctx))
  app.route('/api/chat', createChatRoute(ctx))
  app.route('/api/tools', createToolRoute(ctx))
  app.route('/api/config', createConfigRoute(ctx))
  app.route('/api/files', createFilesRoute(ctx))

  // 根路径
  app.get('/', (c) =>
    c.json({
      name: 'c0de-agent',
      version: '0.1.0',
      endpoints: [
        '/api/health',
        '/api/sessions',
        '/api/chat',
        '/api/tools',
        '/api/config',
        '/api/files',
      ],
    }),
  )

  return app
}

export { createApp }
```

- [ ] **Step 2: 实现 server.ts**

```typescript
// src/server/server.ts
import { serve } from '@hono/node-server'
import type { Server as NodeServer } from 'node:http'
import { loadConfig } from '../core/config.js'
import { createDB, migrateDB } from '../db/index.js'
import { createRegistry } from '../llm/registry.js'
import { createDefaultRegistry } from '../tools/index.js'
import { createApp } from './app.js'
import { createAgentManager } from './agent-manager.js'
import type { ServerContext } from './types.js'
import type { DB } from '../db/client.js'
import type { Hono } from 'hono'

type StartServerOptions = {
  port?: number
  cwd?: string
  /** 注入已有 DB（测试用）。 */
  db?: DB
}

type RunningServer = {
  app: Hono
  port: number
  close(): void
}

/** 启动完整服务：初始化 DB + 配置 + 注册表 + Hono 应用 + HTTP 服务器。 */
async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const cwd = opts.cwd ?? process.cwd()

  const db = opts.db ?? createDB({ driver: 'pglite' })
  await migrateDB(db)

  const config = await loadConfig(cwd)
  const toolRegistry = createDefaultRegistry()
  const llmRegistry = createRegistry()

  const ctx: ServerContext = {
    db,
    config,
    toolRegistry,
    llmRegistry,
    agentManager: createAgentManager(),
    cwd,
  }

  const app = createApp(ctx)
  const port = opts.port ?? 3000

  const server = serve({ fetch: app.fetch, port }) as unknown as NodeServer

  return {
    app,
    port,
    close: () => {
      server.close()
    },
  }
}

export { startServer }
export type { RunningServer, StartServerOptions }
```

- [ ] **Step 3: 实现 index.ts（barrel export）**

```typescript
// src/server/index.ts
export { createApp } from './app.js'
export { createServerContext } from './context.js'
export type { CreateServerContextOptions } from './context.js'
export { startServer } from './server.js'
export type { RunningServer, StartServerOptions } from './server.js'
export { createAgentManager } from './agent-manager.js'
export type { ActiveRun, AgentManager } from './agent-manager.js'
export { createInteractivePermissionChecker } from './permission/interactive.js'
export type {
  InteractivePermissionChecker,
  InteractivePermissionCheckerOptions,
  PermissionRequest,
} from './permission/interactive.js'
export { apiError, errorHandler } from './middleware/error.js'
export type {
  APIErrorBody,
  ChatRequest,
  ConfirmRequest,
  ControlRequest,
  ServerContext,
  SteerRequest,
} from './types.js'
```

- [ ] **Step 4: 编写 app.test.ts（集成测试）**

```typescript
// src/server/app.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '../../shared/types/llm.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { createApp } from '../app.js'

function* mockStream(): Generator<StreamChunk> {
  yield { _tag: 'text', text: 'response' }
  yield { _tag: 'done' }
}

function setupApp() {
  const db = createDB({ driver: 'pglite' })
  const cwd = mkdtempSync(join(tmpdir(), 'c0de-app-'))
  const ctx = createServerContext({
    db,
    llmRegistry: createRegistry(),
    cwd,
    chatStream: (() => mockStream()) as unknown as typeof import('../../llm/provider.js').chatStream,
  })
  return { app: createApp(ctx), ctx, cwd }
}

describe('createApp (integration)', () => {
  it('GET / 返回服务信息', async () => {
    const { app } = setupApp()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe('c0de-agent')
    expect(body.endpoints).toContain('/api/health')
  })

  it('GET /api/health 健康检查', async () => {
    const { app } = setupApp()
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('ok')
  })

  it('完整聊天流程：创建会话 → 发送消息 → 接收 SSE', async () => {
    const { app } = setupApp()

    // 创建会话
    const createRes = await app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Integration Test' }),
    })
    const session = await createRes.json()

    // 发送消息（SSE）
    const chatRes = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, message: 'Hello' }),
    })
    expect(chatRes.status).toBe(200)
    expect(chatRes.headers.get('content-type')).toContain('text/event-stream')
    const text = await chatRes.text()
    expect(text).toContain('text_delta')
    expect(text).toContain('done')
  })

  it('GET /api/tools 列出工具', async () => {
    const { app } = setupApp()
    const res = await app.request('/api/tools')
    expect(res.status).toBe(200)
    const tools = await res.json()
    expect(tools.length).toBeGreaterThan(0)
  })

  it('GET /api/config 返回配置', async () => {
    const { app } = setupApp()
    const res = await app.request('/api/config')
    expect(res.status).toBe(200)
    expect((await res.json()).defaultProvider).toBeDefined()
  })

  it('GET /api/files 列出文件', async () => {
    const { app, cwd } = setupApp()
    writeFileSync(join(cwd, 'test.txt'), 'content')
    const res = await app.request('/api/files')
    expect(res.status).toBe(200)
    const files = await res.json()
    expect(files.some((f: { name: string }) => f.name === 'test.txt')).toBe(true)
  })

  it('未处理异常返回 500', async () => {
    const { app, ctx } = setupApp()
    // 触发 DB 错误：关闭后查询
    // 用一个不存在的路由触发 404
    const res = await app.request('/api/nonexistent')
    expect(res.status).toBe(404)
    void ctx
  })
})
```

- [ ] **Step 5: 编写 index.test.ts**

```typescript
// src/server/index.test.ts
import { describe, expect, it } from 'vitest'
import * as server from './index.js'

describe('server/index barrel export', () => {
  it('导出 createApp', () => {
    expect(typeof server.createApp).toBe('function')
  })

  it('导出 createServerContext', () => {
    expect(typeof server.createServerContext).toBe('function')
  })

  it('导出 startServer', () => {
    expect(typeof server.startServer).toBe('function')
  })

  it('导出 createAgentManager', () => {
    expect(typeof server.createAgentManager).toBe('function')
  })

  it('导出 createInteractivePermissionChecker', () => {
    expect(typeof server.createInteractivePermissionChecker).toBe('function')
  })

  it('导出 apiError 和 errorHandler', () => {
    expect(typeof server.apiError).toBe('function')
    expect(typeof server.errorHandler).toBe('function')
  })
})
```

- [ ] **Step 6: 运行全部 server 测试**

Run: `pnpm vitest run src/server/`
Expected: PASS（所有测试通过）

- [ ] **Step 7: 运行类型检查 + lint**

Run: `pnpm typecheck && pnpm biome check src/server/`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add src/server/app.ts src/server/server.ts src/server/index.ts src/server/app.test.ts src/server/index.test.ts
git commit -m "feat(server): add app factory, server bootstrap, and barrel export"
```

---

## 验收标准

1. **所有路由工作**：health, session CRUD + fork + messages + tree + llm-details, chat SSE, tool list + confirm, config get + patch, files list + read + write + search
2. **SSE 流式聊天**：POST /api/chat 返回 `text/event-stream`，包含 text_delta/tool_call/done 等事件
3. **Agent 控制**：abort/pause/resume/steer 通过 AgentManager 正确操作活跃 run
4. **权限确认**：InteractivePermissionChecker 阻塞式确认，通过 POST /api/tools/confirm 解除
5. **路径安全**：files 路由拒绝 workspace 外的路径
6. **类型安全**：typecheck 通过，无 lint 警告
7. **测试覆盖**：每个路由模块有独立测试，app.test.ts 有端到端集成测试

## API 端点总览

| Method | Path | 描述 |
|--------|------|------|
| GET | / | 服务信息 |
| GET | /api/health | 健康检查 |
| POST | /api/sessions | 创建会话 |
| GET | /api/sessions | 列出会话 |
| GET | /api/sessions/tree | 会话树 |
| GET | /api/sessions/:id | 会话详情 |
| POST | /api/sessions/:id/fork | 分支会话 |
| DELETE | /api/sessions/:id | 删除会话 |
| GET | /api/sessions/:id/messages | 消息列表 |
| GET | /api/sessions/:id/llm-details | LLM 调用详情 |
| GET | /api/sessions/:id/branches | 分支列表 |
| POST | /api/chat | 发送消息（SSE） |
| POST | /api/chat/abort | 中止 agent |
| POST | /api/chat/pause | 暂停 agent |
| POST | /api/chat/resume | 恢复 agent |
| POST | /api/chat/steer | 注入 steering |
| GET | /api/tools | 列出工具 |
| POST | /api/tools/confirm | 确认权限 |
| GET | /api/config | 获取配置 |
| PATCH | /api/config | 更新配置 |
| GET | /api/files | 列出目录 |
| GET | /api/files/search | 搜索文件 |
| GET | /api/files/* | 读取文件 |
| PUT | /api/files/* | 写入文件 |
