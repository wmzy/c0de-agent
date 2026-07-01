# Agent 前端切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 primary agent 前端切换 + `@agent` 调用 subagent，对标 opencode 的 `build`/`plan` 切换与 `@subagent` 交互。

**Architecture:** AgentConfig 增加 `agentName`/`agentRolePrompt` 两个字段（避免 shared→core 循环依赖）。primary agent 的 systemPrompt 通过 prompt-registry 的 role section override 注入动态 prompt（保留工具/项目上下文）。`GET /api/agents` 暴露注册表；`POST /api/chat` 接受 `body.agent`/`body.agents`。前端 AgentSelector 下拉 + AtFilePopover 扩展 @ mention。

**Tech Stack:** TypeScript, Hono (server), React 19 + Linaria (web), Vitest (test), Biome (lint)

**Spec:** `docs/superpowers/specs/2026-07-01-agent-frontend-switching-design.md`

**实现优化注记：** Spec §4.2 原设计在 `AgentState` 加 `agentDef`（引用 `core/agents/types.ts` 的 `AgentDefinition`）。本 plan 改为在 `AgentConfig`（`shared/types/agent.ts`）加 `agentName` + `agentRolePrompt` 两个轻量字段——避免 shared→core 循环依赖，且 config 本身就是 agent 配置载体，更符合现有架构。

---

### Task 1: 内置 primary agents + 类型扩展

**Files:**
- Modify: `src/shared/types/agent.ts` (AgentConfig ~line 19-29, LLMSegment ~line 83-97)
- Modify: `src/core/agents/builtin.ts`
- Test: `src/core/agents/builtin.test.ts`

- [ ] **Step 1: 扩展 AgentConfig 类型**

在 `src/shared/types/agent.ts` 的 `AgentConfig` 类型末尾（`maxTurns?: number` 后）加两个字段：

```ts
type AgentConfig = {
  provider: string
  model: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  tools: string[]
  plugins: string[]
  maxTurns?: number
  /** primary agent 名（段记录用，spec: agent-frontend-switching §4.2）。 */
  agentName?: string
  /** primary agent 的 role prompt（仅覆盖 role section，保留动态上下文）。 */
  agentRolePrompt?: string
}
```

在 `LLMSegment` 类型加字段（`calls: LLMCall[]` 前）：

```ts
type LLMSegment = {
  id: string
  fingerprint: string
  provider: string
  model: string
  systemPrompt: string
  tools: ChatTool[]
  startedAt: number
  trigger: SegmentTrigger
  /** 段首 primary agent 名（段检测比较用，spec: agent-frontend-switching §4.3）。 */
  agentName?: string
  contextWindow?: number
  calls: LLMCall[]
}
```

- [ ] **Step 2: 更新 builtin 测试（先写失败测试）**

在 `src/core/agents/builtin.test.ts` 修改断言。当前第一个测试断言 4 个名字：

```ts
describe('BUILTIN_AGENTS', () => {
  it('包含 6 个内置 agent（4 subagent + 2 primary）', () => {
    const names = BUILTIN_AGENTS.map((d) => d.name).sort()
    expect(names).toEqual(['coder', 'default', 'general', 'plan', 'researcher', 'reviewer'])
  })

  it('所有内置 agent source 为 builtin', () => {
    for (const def of BUILTIN_AGENTS) {
      expect(def.source).toBe('builtin')
    }
  })

  it('每个内置 agent 有 name/description', () => {
    for (const def of BUILTIN_AGENTS) {
      expect(def.name).toBeTruthy()
      expect(def.description).toBeTruthy()
    }
  })

  it('default 和 plan 是 primary 模式', () => {
    const primaryAgents = BUILTIN_AGENTS.filter((d) => d.mode === 'primary')
    expect(primaryAgents.map((d) => d.name).sort()).toEqual(['default', 'plan'])
  })

  it('default 的 systemPrompt 为空（走默认 role）', () => {
    const def = BUILTIN_AGENTS.find((d) => d.name === 'default')
    expect(def?.systemPrompt).toBe('')
  })

  it('plan 限定只读工具集', () => {
    const plan = BUILTIN_AGENTS.find((d) => d.name === 'plan')
    expect(plan?.tools).toEqual(['read', 'grep', 'glob', 'bash'])
    expect(plan?.systemPrompt).toContain('Plan Mode')
  })

  it('researcher 是只读（不含 write/edit/bash）', () => {
    const researcher = BUILTIN_AGENTS.find((d) => d.name === 'researcher')
    expect(researcher).toBeDefined()
    const tools = researcher?.tools
    expect(tools).toBeDefined()
    expect(tools).not.toContain('write')
    expect(tools).not.toContain('edit')
  })

  it('general 允许递归 task（maxRecursion >= 1）', () => {
    const general = BUILTIN_AGENTS.find((d) => d.name === 'general')
    expect(general).toBeDefined()
    expect(general?.maxRecursion ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('coder/researcher/reviewer 默认禁止递归 task（maxRecursion 0 或缺省）', () => {
    for (const def of BUILTIN_AGENTS) {
      if (def.name === 'general') continue
      if (def.mode === 'primary') continue
      expect(def.maxRecursion ?? 0).toBe(0)
    }
  })
})
```

- [ ] **Step 3: 运行测试验证失败**

Run: `npx vitest run src/core/agents/builtin.test.ts`
Expected: FAIL — `expect(names).toEqual([...6个])` 收到 4 个

- [ ] **Step 4: 实现 builtin primary agents**

在 `src/core/agents/builtin.ts` 的 `WORKER_BASE` 常量之后、`BUILTIN_AGENTS` 数组之前加 `PLAN_ROLE`：

```ts
/** Plan 模式 primary agent 的 role prompt（覆盖 role section）。 */
const PLAN_ROLE = `You are c0de-agent in **Plan Mode**. Your job is to investigate the codebase and produce a clear, actionable plan — NOT to make changes directly.

- Use read-only tools (grep/glob/read) to understand the structure and relevant code.
- Ask clarifying questions when requirements are ambiguous.
- When ready, present a concrete implementation plan (files to touch, approach, risks).
- Do NOT use edit/write tools to modify code. You may run bash for investigation only.`
```

在 `BUILTIN_AGENTS` 数组**开头**（`general` 之前）加两个 primary agent：

```ts
const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: 'default',
    description: '通用助手（默认）。全工具，动态系统提示。',
    systemPrompt: '',
    mode: 'primary',
    source: 'builtin',
  },
  {
    name: 'plan',
    description: '计划模式（只读）。专注调研与方案设计，不直接改代码。',
    tools: ['read', 'grep', 'glob', 'bash'],
    systemPrompt: PLAN_ROLE,
    mode: 'primary',
    source: 'builtin',
  },
  {
    name: 'general',
    description: '通用助手，全工具，可递归派生子任务。默认子 agent。',
    // ... 现有内容不变
  },
  // ... 其余不变
]
```

更新注释 `/** 4 个内置默认 agent。 */` → `/** 6 个内置 agent（2 primary + 4 subagent）。 */`

- [ ] **Step 5: 运行测试验证通过**

Run: `npx vitest run src/core/agents/builtin.test.ts`
Expected: PASS — 全部测试通过

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/agent.ts src/core/agents/builtin.ts src/core/agents/builtin.test.ts
git commit -m "feat: 新增 default/plan 两个 primary agent + AgentConfig 类型扩展"
```

---

### Task 2: loop role override + 段 agentName

**Files:**
- Modify: `src/core/loop.ts` (prompt 构建 ~line 340-348, 段创建 ~line 558-570, subagent config ~line 146)
- Test: `src/core/loop.test.ts`

- [ ] **Step 1: 写 role override 失败测试**

在 `src/core/loop.test.ts` 的 `describe('agentLoop', ...)` 内追加测试。需要捕获 chatStream 收到的 system 参数：

```ts
  it('agentRolePrompt 覆盖 role section 但保留工具段', async () => {
    const db = await makeDB()
    const session = await createSession(db, 'Test')
    await appendMessage(db, session.id, { role: 'user', content: [{ _tag: 'text', text: 'hi' }] })

    let capturedSystem = ''
    // mockStream 捕获 request.system
    const captureStream = (() =>
      (async function* (request: { system?: string }): AsyncGenerator<StreamChunk> {
        capturedSystem = request.system ?? ''
        yield { _tag: 'text', text: 'planned' }
        yield { _tag: 'done' }
      })()) as unknown as () => AsyncGenerator<StreamChunk>

    const deps = makeMockDeps(db, captureStream)
    const state = makeState(session, [])
    // 设置 primary agent role prompt
    state.config.agentRolePrompt = 'OVERRIDE_PLAN_ROLE'
    // 注册 read 工具使工具段出现
    state.config.tools = ['read']
    state.tools = listTools(deps.toolRegistry, { config: {}, cwd: deps.cwd }).filter((t) =>
      state.config.tools.includes(t.name),
    )

    for await (const _event of agentLoop(state, deps)) {
      // 消费完
    }

    expect(capturedSystem).toContain('OVERRIDE_PLAN_ROLE')
    // 工具段仍保留（未被整段替换抹掉）
    expect(capturedSystem).toContain('## Available Tools')
    expect(capturedSystem).toContain('**read**')
  })
```

注：`makeDB`、`createSession`、`appendMessage`、`listTools` 需在文件顶部已 import（检查现有 import，缺则补）。`StreamChunk` 类型已 import。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/core/loop.test.ts -t "agentRolePrompt"`
Expected: FAIL — `capturedSystem` 不含 `OVERRIDE_PLAN_ROLE`（role override 未实现）

- [ ] **Step 3: 实现 role override**

在 `src/core/loop.ts` 顶部 import 区加（如未有）：

```ts
import { buildDynamicPrompt, createPromptRegistry, registerPromptSection } from './prompt-registry.js'
```

注：当前已 import `buildDynamicPrompt` 和 `buildSystemPrompt`。需追加 `createPromptRegistry` 和 `registerPromptSection`。

修改 prompt 构建处（当前 ~line 344-348）。当前代码：

```ts
    const systemPrompt =
      (state.config.systemPrompt ??
        (deps.promptRegistry
          ? buildDynamicPrompt(deps.promptRegistry, promptCtx)
          : buildSystemPrompt(promptCtx))) + modeHint
```

替换为：

```ts
    // primary agent 的 role prompt 覆盖 role section（保留工具/项目等动态段）。
    // 仅当未走 config.systemPrompt 整段替换时生效。
    const baseReg = deps.promptRegistry ?? createPromptRegistry()
    if (state.config.agentRolePrompt) {
      registerPromptSection(baseReg, {
        id: 'role',
        content: state.config.agentRolePrompt,
        priority: 0,
      })
    }
    const systemPrompt =
      (state.config.systemPrompt ?? buildDynamicPrompt(baseReg, promptCtx)) + modeHint
```

- [ ] **Step 4: 段创建存 agentName**

在 `src/core/loop.ts` 段创建处（`segments.push({ ... })` 或 `newSegment` 构造），给段对象加 `agentName`。找到段对象字面量（含 `fingerprint`/`provider`/`model`/`systemPrompt`/`tools`/`startedAt`/`trigger` 字段），在 `trigger` 后加：

```ts
        agentName: state.config.agentName,
```

- [ ] **Step 5: subagent 清除继承的 agentRolePrompt**

在 `src/core/loop.ts` 的 `runSubAgent` 函数内，子 agent config 构建处（~line 144-150，`...parent.config` spread 后）。当前：

```ts
      ...parent.config,
      systemPrompt: def.systemPrompt,
      tools: childTools,
```

改为：

```ts
      ...parent.config,
      systemPrompt: def.systemPrompt,
      // 子 agent 走整段 systemPrompt 替换，清除父的 role override 避免干扰
      agentRolePrompt: undefined,
      tools: childTools,
```

- [ ] **Step 6: 运行测试验证通过**

Run: `npx vitest run src/core/loop.test.ts -t "agentRolePrompt"`
Expected: PASS

Run: `npx vitest run src/core/loop.test.ts`
Expected: PASS — 全部测试通过（现有测试不受影响）

- [ ] **Step 7: Commit**

```bash
git add src/core/loop.ts src/core/loop.test.ts
git commit -m "feat: primary agent role section override + 段记录 agentName"
```

---

### Task 3: chat 路由 agent 参数

**Files:**
- Modify: `src/server/routes/chat.ts` (~line 137-228)
- Test: `src/server/routes/chat.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/server/routes/chat.test.ts` 的 `describe('chat route (SSE)', ...)` 内追加：

```ts
  it('POST / 带 body.agent=plan 使用只读工具集', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'test', agent: 'plan' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    const events = parseSSEEvents(text)
    expect(events.some((e) => e.event === 'done')).toBe(true)
  })

  it('POST / 带 body.agent=unknown 返回 400', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'test', agent: 'nonexistent' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST / 带 body.agent=general（subagent）返回 400', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'test', agent: 'general' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST / 带 body.agents 注入 subagent 指令前缀', async () => {
    const { app, sessionId } = await setup()
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        message: '帮我实现 X',
        agents: ['coder'],
      }),
    })
    expect(res.status).toBe(200)
    // mockChatStream 不暴露 message，但 200 + done 表示注入未报错
    const text = await res.text()
    const events = parseSSEEvents(text)
    expect(events.some((e) => e.event === 'done')).toBe(true)
  })
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/server/routes/chat.test.ts -t "body.agent"`
Expected: FAIL — `agent: 'plan'` 可能 200（当前忽略 agent 参数），但 `agent: 'nonexistent'` 也 200（未校验）

- [ ] **Step 3: 实现 chat 路由 agent 解析**

在 `src/server/routes/chat.ts` 的 POST `/` handler 内，`provider`/`model`/`tools` 计算之后、段检测之前（当前 ~line 139-148 之后），插入 agent 解析：

找到这段代码（~line 137-148）：

```ts
    const provider = (body.provider as string) ?? ctx.config.defaultProvider
    const model = (body.model as string) ?? ctx.config.defaultModel
    const tools =
      (body.tools as string[] | undefined) ??
      listTools(ctx.toolRegistry, { config: {}, cwd }).map((t) => t.name)
```

在其后插入：

```ts
    // primary agent 解析（spec: agent-frontend-switching §4.3）
    const agentName = (body.agent as string) ?? 'default'
    const agentDef = ctx.agentRegistry.get(agentName)
    if (!agentDef || agentDef.mode === 'subagent') {
      return apiError(
        c,
        400,
        'INVALID_AGENT',
        `Unknown or non-primary agent: ${agentName}`,
      )
    }
    // agent def 覆盖：tools（plan 限只读）、model（可选）
    const resolvedTools = agentDef.tools ?? tools
    const resolvedModel = agentDef.model ?? model
```

- [ ] **Step 4: 段检测加 agent 比较**

修改段检测逻辑（~line 150-167）。当前：

```ts
    if (active) {
      const reqTools = new Set(tools)
      const segTools = new Set(active.tools.map((t) => t.name))
      const toolsDiffer =
        reqTools.size !== segTools.size || [...reqTools].some((t) => !segTools.has(t))
      const modelDiffer = active.provider !== provider || active.model !== model
      const confirmed = (body.confirmSegmentBreak as boolean | undefined) === true
      if ((modelDiffer || toolsDiffer) && !confirmed) {
```

改为（用 `resolvedTools`/`resolvedModel`，加 `agentDiffer`）：

```ts
    if (active) {
      const reqTools = new Set(resolvedTools)
      const segTools = new Set(active.tools.map((t) => t.name))
      const toolsDiffer =
        reqTools.size !== segTools.size || [...reqTools].some((t) => !segTools.has(t))
      const modelDiffer = active.provider !== provider || active.model !== resolvedModel
      // 旧段 agentName undefined 视为 'default'
      const agentDiffer = (active.agentName ?? 'default') !== agentName
      const confirmed = (body.confirmSegmentBreak as boolean | undefined) === true
      if ((modelDiffer || toolsDiffer || agentDiffer) && !confirmed) {
```

- [ ] **Step 5: @agent 注入 + agentConfig 构建**

在 `userContent` 构建之后（当前 ~line 113-121，images 处理之后），插入 @ 注入。找到：

```ts
    const userContent: MessageContent[] = [{ _tag: 'text', text: message }]
    const images = body.images as Array<{ mediaType: string; data: string }> | undefined
    if (images?.length) {
      for (const img of images) {
        userContent.push({ _tag: 'image', mediaType: img.mediaType, data: img.data })
      }
    }
```

在其后加 @ 注入：

```ts
    // @agent 调用 subagent：在消息前注入指令（复用 task 工具派生）
    const mentionedAgents = (body.agents as string[]) ?? []
    if (mentionedAgents.length > 0) {
      const valid = mentionedAgents
        .map((n) => ctx.agentRegistry.get(n))
        .filter((d): d is NonNullable<typeof d> => Boolean(d && d.mode !== 'primary'))
      if (valid.length > 0) {
        const names = valid.map((d) => d.name).join(', ')
        const first = userContent[0]
        if (first && first._tag === 'text') {
          first.text = `[User requested subagent(s): ${names}]\n\n${first.text}`
        }
      }
    }
```

修改 `agentConfig` 构建（~line 223-228）。当前：

```ts
      const agentConfig: AgentConfig = {
        provider,
        model,
        tools,
        plugins: ctx.config.plugins.enabled,
      }
```

改为：

```ts
      const agentConfig: AgentConfig = {
        provider,
        model: resolvedModel,
        tools: resolvedTools,
        plugins: ctx.config.plugins.enabled,
        agentName,
        ...(agentDef.systemPrompt ? { agentRolePrompt: agentDef.systemPrompt } : {}),
      }
```

- [ ] **Step 6: 运行测试验证通过**

Run: `npx vitest run src/server/routes/chat.test.ts`
Expected: PASS — 全部测试通过

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/chat.ts src/server/routes/chat.test.ts
git commit -m "feat: chat 路由支持 agent/agents 参数 + 段检测 agent 比较"
```

---

### Task 4: GET /api/agents

**Files:**
- Create: `src/server/routes/agent.ts`
- Create: `src/server/routes/agent.test.ts`
- Modify: `src/server/app.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/server/routes/agent.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import { createAgentRoute } from './agent.js'

let dbHandle: DB | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

async function setup() {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  const ctx = createServerContext({ db, llmRegistry: createRegistry() })
  const app = createAgentRoute(ctx)
  return { app, ctx }
}

describe('agent route', () => {
  it('GET / 返回所有 agent', async () => {
    const { app } = await setup()
    const res = await app.request('/', { method: 'GET' })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.agents.length).toBeGreaterThanOrEqual(6)
  })

  it('GET / 包含 primary 和 subagent', async () => {
    const { app } = await setup()
    const res = await app.request('/', { method: 'GET' })
    const data = await res.json()
    const modes = data.agents.map((a: { mode: string }) => a.mode)
    expect(modes).toContain('primary')
    expect(modes).toContain('subagent')
  })

  it('GET / 每个 agent 有 name/description/mode/source', async () => {
    const { app } = await setup()
    const res = await app.request('/', { method: 'GET' })
    const data = await res.json()
    for (const agent of data.agents) {
      expect(agent.name).toBeTruthy()
      expect(agent.description).toBeTruthy()
      expect(['subagent', 'primary', 'all']).toContain(agent.mode)
      expect(['builtin', 'user', 'project']).toContain(agent.source)
    }
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/server/routes/agent.test.ts`
Expected: FAIL — `createAgentRoute` 未定义

- [ ] **Step 3: 实现 agent 路由**

创建 `src/server/routes/agent.ts`：

```ts
import { Hono } from 'hono'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

function createAgentRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // GET / — 返回所有 agent（前端按 mode 过滤展示）
  app.get('/', (c) => {
    const all = ctx.agentRegistry.list()
    return c.json({
      agents: all.map((d) => ({
        name: d.name,
        description: d.description,
        mode: d.mode,
        source: d.source,
        hasTools: Boolean(d.tools),
      })),
    })
  })

  return app
}

export { createAgentRoute }
```

- [ ] **Step 4: 注册路由**

在 `src/server/app.ts` 的 import 区加：

```ts
import { createAgentRoute } from './routes/agent.js'
```

在路由注册区（`app.route('/api/chat', ...)` 附近）加：

```ts
  app.route('/api/agents', createAgentRoute(ctx))
```

在根路径 `endpoints` 数组加 `'/api/agents'`。

- [ ] **Step 5: 运行测试验证通过**

Run: `npx vitest run src/server/routes/agent.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/agent.ts src/server/routes/agent.test.ts src/server/app.ts
git commit -m "feat: GET /api/agents 暴露 agent 注册表"
```

---

### Task 5: 前端 agent service + AgentSelector

**Files:**
- Modify: `src/web/services/agent.ts`
- Create: `src/web/components/AgentSelector.tsx`
- Create: `src/web/components/AgentSelector.test.tsx`
- Modify: `src/web/hooks/useComposerDefaults.ts`

- [ ] **Step 1: 扩展 agent service**

在 `src/web/services/agent.ts` 的 `agentAPI` 对象内加 `listAgents` 方法：

```ts
  listAgents: () =>
    apiRequest<{ agents: AgentListItem[] }>('/api/agents', { method: 'GET' }),
```

在文件顶部加类型定义：

```ts
type AgentListItem = {
  name: string
  description: string
  mode: 'subagent' | 'primary' | 'all'
  source: string
  hasTools: boolean
}
```

并 export：`export type { AgentListItem }`

- [ ] **Step 2: 写 AgentSelector 失败测试**

创建 `src/web/components/AgentSelector.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentSelector } from './AgentSelector.js'
import type { AgentListItem } from '../services/agent.js'

const agents: AgentListItem[] = [
  { name: 'default', description: '通用', mode: 'primary', source: 'builtin', hasTools: false },
  { name: 'plan', description: '计划', mode: 'primary', source: 'builtin', hasTools: true },
  { name: 'coder', description: '编码', mode: 'subagent', source: 'builtin', hasTools: true },
]

describe('AgentSelector', () => {
  it('只渲染 primary agent（过滤 subagent）', () => {
    render(<AgentSelector value="default" onChange={vi.fn()} agents={agents} />)
    const select = screen.getByRole('combobox')
    const options = within(select).getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(select).toHaveValue('default')
  })

  it('切换时调用 onChange', async () => {
    const onChange = vi.fn()
    render(<AgentSelector value="default" onChange={onChange} agents={agents} />)
    const select = screen.getByRole('combobox')
    await userEvent.selectOptions(select, 'plan')
    expect(onChange).toHaveBeenCalledWith('plan')
  })
})
```

注：需 import `within` 和 `userEvent`（检查 `src/web/test-setup.ts` 是否已配置 userEvent）。

- [ ] **Step 3: 运行测试验证失败**

Run: `npx vitest run src/web/components/AgentSelector.test.tsx`
Expected: FAIL — 模块未找到

- [ ] **Step 4: 实现 AgentSelector**

创建 `src/web/components/AgentSelector.tsx`（样式参考 ModelSelector 的 `selectControl`）：

```tsx
import { css } from '@linaria/core'
import type { AgentListItem } from '../services/agent.js'

const selectControl = css`
  padding: 4px 28px 4px 8px;
  min-height: 28px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
`

export function AgentSelector({
  value,
  onChange,
  agents,
}: {
  value: string
  onChange: (name: string) => void
  agents: AgentListItem[]
}) {
  const primary = agents.filter((a) => a.mode !== 'subagent')
  return (
    <select
      className={selectControl}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="切换 agent"
      data-testid="agent-selector"
    >
      {primary.map((a) => (
        <option key={a.name} value={a.name}>
          {a.name}
        </option>
      ))}
    </select>
  )
}
```

- [ ] **Step 5: useComposerDefaults 加 agent state**

在 `src/web/hooks/useComposerDefaults.ts` 加 agent 状态管理。在 `useState` 区加：

```ts
  const [agent, setAgentState] = useState<string>(
    () => localStorage.getItem('c0de-agent:selectedAgent') ?? 'default',
  )
  const setAgent = (name: string) => {
    localStorage.setItem('c0de-agent:selectedAgent', name)
    setAgentState(name)
  }
```

在 return 对象加 `agent` 和 `setAgent`：

```ts
  return { selection, setSelection, enabledTools, setEnabledTools, agents, setAgent, providers, providersData }
```

- [ ] **Step 6: 运行测试验证通过**

Run: `npx vitest run src/web/components/AgentSelector.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/web/services/agent.ts src/web/components/AgentSelector.tsx src/web/components/AgentSelector.test.tsx src/web/hooks/useComposerDefaults.ts
git commit -m "feat: AgentSelector 组件 + useComposerDefaults agent 状态"
```

---

### Task 6: ChatView 接线 AgentSelector

**Files:**
- Modify: `src/web/views/ChatView.tsx`

- [ ] **Step 1: DraftSession 接入 AgentSelector**

在 `src/web/views/ChatView.tsx` 的 `DraftSession` 和 `ChatSession` 组件中，`useComposerDefaults` 解构加 `agent`/`setAgent`：

```ts
  const { selection, setSelection, enabledTools, setEnabledTools, agent, setAgent } = useComposerDefaults()
```

在两个组件中加 agents query（useQuery 获取 agent 列表）：

```ts
  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentAPI.listAgents(),
    staleTime: 60_000,
  })
```

import 加：
```ts
import { AgentSelector } from '../components/AgentSelector.js'
import { agentAPI } from '../services/agent.js'
```

在 `DraftSession` 的 `handleSend`，opts 加 agent：

```ts
    const opts = {
      provider: selection.provider,
      model: selection.model,
      agent,
      ...(enabledTools ? { tools: Array.from(enabledTools) } : {}),
      ...(payload.images.length ? { images: payload.images } : {}),
      ...(payload.files.length ? { files: payload.files } : {}),
    }
```

在 `DraftSession` 和 `ChatSession` 的 `<Chat>` 的 `modelBar` slot 加 AgentSelector（与 ModelSelector 并列）：

```tsx
      modelBar={
        <>
          <AgentSelector value={agent} onChange={setAgent} agents={agentsData?.agents ?? []} />
          <ModelSelector value={selection} onChange={setSelection} />
        </>
      }
```

- [ ] **Step 2: ChatOpts 加 agent/agents 字段**

在 `src/web/hooks/useChat.ts` 的 `ChatOpts` 类型加字段（当前 ~line 36-43）：

```ts
type ChatOpts = {
  provider?: string
  model?: string
  tools?: string[]
  agent?: string
  agents?: string[]
  images?: Array<{ mediaType: string; data: string }>
  files?: string[]
  confirmSegmentBreak?: boolean
}
```

`sendMessage(content, opts)` 会把 opts 展开进 POST /api/chat body，后端 `body.agent`/`body.agents` 直接读到。

在 `ChatSession` 的 `onSend` 回调中，`sendMessage` 调用 opts 加 `agent`（以及 payload.agents）：

```ts
    chat.sendMessage(payload.text, {
      provider: selection.provider,
      model: selection.model,
      agent,
      ...(enabledTools ? { tools: Array.from(enabledTools) } : {}),
      ...(payload.images.length ? { images: payload.images } : {}),
      ...(payload.files.length ? { files: payload.files } : {}),
      ...(payload.agents.length ? { agents: payload.agents } : {}),
    })
```

在 pending 首条消息恢复处（`useEffect` 消费 `pendingFirstMessage`），opts 也要兼容 agent：

```ts
    const pending = pendingFirstMessage.get(sessionId)
    if (!pending) return
    consumed.current = true
    pendingFirstMessage.delete(sessionId)
    // 恢复时若 pending.opts 无 agent，用当前 agent
    if (!pending.opts.agent) pending.opts.agent = agent
```

- [ ] **Step 3: 验证类型检查**

Run: `npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add src/web/views/ChatView.tsx
git commit -m "feat: ChatView 接入 AgentSelector"
```

---

### Task 7: @ mention 调用 subagent

**Files:**
- Modify: `src/web/composer/types.ts`
- Modify: `src/web/composer/AtFilePopover.tsx`
- Modify: `src/web/composer/Composer.tsx` (SendPayload)
- Modify: `src/web/views/ChatView.tsx` (handleSend 提取 @agent)

- [ ] **Step 1: SendPayload 加 agents 字段**

在 `src/web/composer/Composer.tsx` 的 `SendPayload` 类型加字段：

```ts
type SendPayload = {
  text: string
  files: string[]
  images: ImagePart[]
  agents: string[]
}
```

- [ ] **Step 2: AtFilePopover 扩展 agent 渲染**

修改 `src/web/composer/AtFilePopover.tsx`，Props 加 agents：

```tsx
import { css } from '@linaria/core'
import type { AgentListItem } from '../services/agent.js'
import type { FileSearchResult } from '../hooks/useFiles.js'

// ... 现有样式不变 ...

const agentItem = css`
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  cursor: pointer;
  background: none;
  border: none;
  color: var(--text);
  font-size: 13px;
  border-bottom: 1px solid var(--border);
  &:hover,
  &.active {
    background: var(--bg-secondary);
  }
`

const agentLabel = css`
  color: var(--accent, #4a9eff);
  font-weight: 600;
  font-size: 11px;
  display: block;
  margin-bottom: 2px;
`

type Props = {
  results: FileSearchResult[]
  activeIndex: number
  onSelect: (path: string) => void
  agents: AgentListItem[]
  query: string
  activeAgentIndex: number
  onAgentSelect: (name: string) => void
}

function AtFilePopover(props: Props) {
  const files = props.results.filter((r) => r.type === 'file').slice(0, 20)
  // @ mention 只显示 subagent/all（非 primary），按 query 过滤 name
  const subagents = props.agents
    .filter((a) => a.mode !== 'primary')
    .filter((a) => !props.query || a.name.includes(props.query))
    .slice(0, 5)
  if (files.length === 0 && subagents.length === 0) return null
  return (
    <div
      className={popover}
      role="listbox"
      data-testid="at-menu"
      onMouseDown={(e) => e.preventDefault()}
    >
      {subagents.map((a, i) => (
        <button
          key={a.name}
          role="option"
          aria-selected={i === props.activeAgentIndex}
          className={`${agentItem} ${i === props.activeAgentIndex ? 'active' : ''}`}
          onClick={() => props.onAgentSelect(a.name)}
          type="button"
        >
          <span className={agentLabel}>@{a.name}</span>
          <span>{a.description}</span>
        </button>
      ))}
      {files.map((f, i) => (
        <button
          key={f.path}
          role="option"
          aria-selected={subagents.length + i === props.activeIndex}
          className={`${item} ${subagents.length + i === props.activeIndex ? 'active' : ''}`}
          onClick={() => props.onSelect(f.path)}
          type="button"
        >
          {f.path}
        </button>
      ))}
    </div>
  )
}

export { AtFilePopover }
```

- [ ] **Step 3: Composer 传递 agents + 发送提取**

在 `src/web/composer/Composer.tsx` 中：

1. Props 加 `agents: AgentListItem[]`
2. 用 useQuery 获取或由 ChatView 传入
3. `useComposer` 的 `send` 回调提取 agents：从文本 `@name` 匹配验证

在 Composer 内 send 逻辑（通过 useComposer 的 onSend 回调），修改 payload 构造：

```tsx
function Composer(props: ComposerProps) {
  // ...
  const handleSend = (payload: { text: string; files: string[]; images: ImagePart[] }) => {
    // 从文本提取 @agent names
    const mentions = payload.text.match(/@(\w+)/g) ?? []
    const agentNames = props.agents
      .filter((a) => a.mode !== 'primary')
      .map((a) => a.name)
    const agents = mentions
      .map((m) => m.slice(1))
      .filter((name) => agentNames.includes(name))
    props.onSend({ ...payload, agents })
  }

  const composer = useComposer({
    onSend: handleSend,
    // ...
  })
  // ...
}
```

将 `agents` 传给 `AtFilePopover`，选中 agent 时插入 `@name ` 文本（复用 insertFile 逻辑但插入文本）：

```tsx
  const insertAgentToken = (name: string) => {
    const text = promptToText(composer.promptRef?.current ?? DEFAULT_PROMPT)
    const atIdx = text.lastIndexOf('@')
    if (atIdx === -1) return
    const before = text.slice(0, atIdx)
    let tokenEnd = atIdx + 1
    while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? '')) tokenEnd += 1
    const after = text.slice(tokenEnd)
    const newText = `${before}@${name} ${after}`
    composer.setPromptExternal([
      { type: 'text', content: newText, start: 0, end: newText.length },
    ])
  }
```

Composer 加 `atAgentActive` 状态，渲染 AtFilePopover 时传新 props：

```tsx
  const [atAgentActive, setAtAgentActive] = useState(0)

  // ... 在 JSX 中：
  {composer.popover === 'at' && (
    <AtFilePopover
      results={fileSearch.data ?? []}
      activeIndex={atActive}
      onSelect={(path) => composer.insertFile(path)}
      agents={props.agents}
      query={composer.popoverQuery}
      activeAgentIndex={atAgentActive}
      onAgentSelect={insertAgentToken}
    />
  )}
```

注：`insertAgentToken` 需访问 `setPromptExternal` 和 `promptRef`，需在 `useComposer.ts` return 暴露（见 Step 4）。

```ts
  return {
    // ... 现有 ...
    promptRef,
    setPromptExternal,
  }
```

简化 `insertAgentToken`（暴露后直接用）：

```tsx
  const insertAgentToken = (name: string) => {
    const text = promptToText(composer.promptRef.current)
    const atIdx = text.lastIndexOf('@')
    if (atIdx === -1) return
    const before = text.slice(0, atIdx)
    let tokenEnd = atIdx + 1
    while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? '')) tokenEnd += 1
    const after = text.slice(tokenEnd)
    const newText = `${before}@${name} ${after}`
    composer.setPromptExternal([
      { type: 'text', content: newText, start: 0, end: newText.length },
    ])
  }
```

- [ ] **Step 4: useComposer 暴露 promptRef/setPromptExternal**

在 `src/web/composer/useComposer.ts` 的 return 对象加：

```ts
    promptRef,
    setPromptExternal,
```

- [ ] **Step 5: ChatView 传递 agents + handleSend 携带 agents**

在 `src/web/views/ChatView.tsx` 的 `<Chat>` 加 `agents` prop：

```tsx
      agents={agentsData?.agents ?? []}
```

`handleSend` 的 opts 加 agents：

```ts
    const opts = {
      // ...
      ...(payload.agents.length ? { agents: payload.agents } : {}),
    }
```

- [ ] **Step 6: 验证类型检查 + 测试**

Run: `npx tsc --noEmit`
Expected: 无类型错误

Run: `npx vitest run src/web/`
Expected: 现有前端测试不受影响

- [ ] **Step 7: Commit**

```bash
git add src/web/composer/ src/web/views/ChatView.tsx
git commit -m "feat: @ mention 调用 subagent + SendPayload agents 字段"
```

---

## 验收清单

实现完成后，运行全量测试确认无回归：

```bash
npx vitest run
npx tsc --noEmit
```

功能验证（手动或 E2E）：
1. 前端 AgentSelector 显示 default + plan，切换不报错
2. 选 plan 后发消息，LLM 收到只读工具集 + Plan Mode role
3. 切 default→plan 触发 SegmentBreakDialog
4. `@coder` 输入时 AtFilePopover 显示 coder 项
5. `GET /api/agents` 返回 6+ agent
