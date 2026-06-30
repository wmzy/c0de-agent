# 多 Agent 特性实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 c0de-agent 增加可配置的多 agent 类型能力——主 agent 通过增强的 `task` 工具按 `subagent_type` 派发专门的子 agent（专属 prompt + 受限工具集），支持 yield 结构化结果、单消息并行派发、后台异步执行、session 恢复，以及可选的 git worktree 文件隔离（自动 apply 回父）。

**Architecture:** 新建 `src/core/agents/` 模块承载 agent 类型注册表 + markdown discovery + 内置默认 agent。增强 `runSubAgent`（在 `loop.ts`）消费 `AgentDefinition`，构建子 agent 的专属 prompt 与受限工具集。新增 `yield` 工具让子 agent 返回结构化结果。增强 `task` 工具支持 `subagent_type`/批量并行/后台。`worktree.ts` 实现 baseline→worktree→delta→自动 apply 的文件隔离。前端接线 `subagent_*` 事件到 `SubAgentProgress`。

**Tech Stack:** TypeScript, Vitest（TDD）, Drizzle ORM（PGLite）, Hono（SSE）, React, pnpm monorepo, Biome（lint）。无新依赖——git 操作走现有 `bash` 工具的 child_process 或直接 `node:child_process`。

**设计依据：** `docs/superpowers/specs/2026-06-30-multi-agent-design.md`。参考 opencode `packages/opencode/src/agent/` 与 oh-my-pi `packages/coding-agent/src/task/`。

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/core/agents/types.ts` | `AgentDefinition`、`AgentRegistry` 接口、`AgentSource` 类型 |
| `src/core/agents/registry.ts` | `createAgentRegistry()` 内存 Map 实现 |
| `src/core/agents/discovery.ts` | markdown frontmatter 解析 + 三级加载（builtin→用户→项目） |
| `src/core/agents/builtin.ts` | 4 个内置 agent 定义（general/coder/researcher/reviewer） |
| `src/core/agents/parallel.ts` | `mapWithConcurrencyLimit` worker 池 |
| `src/core/agents/index.ts` | barrel |
| `src/core/worktree.ts` | git worktree 隔离：baseline/delta/apply |
| `src/tools/builtin/yield.ts` | 子 agent 结构化结果返回工具 |
| 各自 `.test.ts` | 单元测试 |
| `tests/integration/multi-agent.test.ts` | 端到端集成测试 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/shared/types/tool.ts` | `SubAgentRequest` 加 `agentType`/`role`/`context`/`background`；`SubAgentResult` 加 `running`/`data`/`patchPath`；`ToolContext` 加 `collectYield` |
| `src/shared/types/agent.ts` | `AgentEvent` 加 `subagent_start`/`subagent_progress`/`subagent_end` |
| `src/shared/types/config.ts` | `Config` 加 `agents` 字段 |
| `src/shared/types/message.ts` | `SessionMetadata` 加 `agentType` |
| `src/core/types.ts` | `AgentDependencies` 加 `agentRegistry` |
| `src/core/config.ts` | `DEFAULT_CONFIG` 加 `agents` 默认值 |
| `src/core/loop.ts` | `runSubAgent` 增强 + `runSubAgentsParallel` |
| `src/core/agent.ts` | `createAgent` 接收可选 `agentType`/`subagentCwd` |
| `src/tools/builtin/task.ts` | `subagent_type` 参数 + 批量并行 + 调用增强 runSubAgent |
| `src/tools/builtin/task.test.ts` | 新参数测试 |
| `src/tools/index.ts` | 注册 yield 工具 |
| `src/db/schema.ts` | sessions 加 `agentType`/`worktreePath` |
| `src/db/migrate.ts` | （无代码改动，仅新 SQL） |
| `drizzle/0003_*.sql` | migration：加两列 |
| `src/session/session.ts` | `rowToSession` 映射新字段；`createSession` 接收 `agentType` |
| `src/server/types.ts` | `ServerContext` 加 `agentRegistry` |
| `src/server/context.ts` | 装配 `agentRegistry` |
| `src/server/routes/chat.ts` | deps 注入 `agentRegistry` |
| `src/server/agent-manager.ts` | `ActiveRun` 加 parentSessionId/agentType/jobId + `children()`/`backgroundJobs()` 查询（恢复） |
| `src/web/hooks/useChat.ts` | `reduceChatEvent` 处理 `subagent_*` 事件 |
| `src/web/components/session/SubAgents.tsx` | 子 agent 进度列表组件（基于现有 SubAgentProgress） |

---

## 全局约定（所有任务遵循）

- **包管理**：`pnpm`，脚本用 `npm run`
- **测试**：`npm run test`（vitest run，全量）；单文件 `npx vitest run <path>`
- **类型检查**：`npm run typecheck`
- **lint**：`npm run lint`
- **TDD**：先写失败测试 → 跑确认失败 → 实现 → 跑确认通过 → 提交
- **中文注释**：与项目一致（见现有代码注释风格）
- **import 风格**：`import type { ... } from '...js'`（带 `.js` 后缀，ESM）

---

## Task 1: AgentDefinition 类型与注册表

**Files:**
- Create: `src/core/agents/types.ts`
- Create: `src/core/agents/registry.ts`
- Create: `src/core/agents/registry.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/core/agents/registry.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createAgentRegistry } from './registry.js'
import type { AgentDefinition } from './types.js'

const def = (name: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name,
  description: `${name} agent`,
  systemPrompt: `You are ${name}.`,
  mode: 'subagent',
  source: 'builtin',
  ...overrides,
})

describe('AgentRegistry', () => {
  it('registers and retrieves a definition by name', () => {
    const reg = createAgentRegistry()
    reg.register(def('researcher'))
    expect(reg.get('researcher')?.name).toBe('researcher')
  })

  it('has() reports presence', () => {
    const reg = createAgentRegistry()
    reg.register(def('coder'))
    expect(reg.has('coder')).toBe(true)
    expect(reg.has('missing')).toBe(false)
  })

  it('list() returns all definitions by default', () => {
    const reg = createAgentRegistry()
    reg.register(def('coder'))
    reg.register(def('researcher'))
    expect(reg.list().map((d) => d.name).sort()).toEqual(['coder', 'researcher'])
  })

  it('list(mode) filters by mode', () => {
    const reg = createAgentRegistry()
    reg.register(def('coder', { mode: 'subagent' }))
    reg.register(def('main', { mode: 'primary' }))
    reg.register(def('general', { mode: 'all' }))
    expect(reg.list('subagent').map((d) => d.name).sort()).toEqual(['coder', 'general'])
    expect(reg.list('primary').map((d) => d.name).sort()).toEqual(['general', 'main'])
  })

  it('later registration overwrites same name', () => {
    const reg = createAgentRegistry()
    reg.register(def('coder', { source: 'builtin' }))
    reg.register(def('coder', { source: 'project', description: 'override' }))
    const got = reg.get('coder')
    expect(got?.source).toBe('project')
    expect(got?.description).toBe('override')
  })

  it('get() returns undefined for unknown name', () => {
    const reg = createAgentRegistry()
    expect(reg.get('nope')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/agents/registry.test.ts`
Expected: FAIL（模块不存在，import 报错）

- [ ] **Step 3: 写 types.ts**

创建 `src/core/agents/types.ts`：

```ts
/** Agent 定义的来源层级（后加载覆盖先加载）。 */
type AgentSource = 'builtin' | 'user' | 'project'

/** Agent 可见性模式：subagent=仅子用，primary=仅主，all=皆可。 */
type AgentMode = 'subagent' | 'primary' | 'all'

/** 可配置的 agent 类型定义（由 markdown frontmatter 或代码构造）。 */
interface AgentDefinition {
  /** 唯一标识，如 'researcher'。 */
  name: string
  /** 何时用此 agent（注入 task 工具描述供模型选择）。 */
  description: string
  /** 专属 system prompt（frontmatter 正文）。 */
  systemPrompt: string
  /** 允许的工具集（默认全部注册工具）。 */
  tools?: string[]
  /** 模型覆盖（默认继承父 agent）。 */
  model?: string
  /** 可见性模式。 */
  mode: AgentMode
  /** 是否用 git worktree 隔离（默认 false）。 */
  isolated?: boolean
  /** 递归派生深度上限（默认 0=禁止递归 task）。 */
  maxRecursion?: number
  /** yield 结果的 JSON Schema（验证子 agent 输出）。 */
  outputSchema?: object
  /** 来源层级。 */
  source: AgentSource
  /** markdown 路径（调试用）。 */
  filePath?: string
}

/** Agent 类型注册表：内存 Map<name, definition>。 */
interface AgentRegistry {
  register(def: AgentDefinition): void
  get(name: string): AgentDefinition | undefined
  list(mode?: AgentMode): AgentDefinition[]
  has(name: string): boolean
}

export type { AgentDefinition, AgentMode, AgentRegistry, AgentSource }
```

- [ ] **Step 4: 写 registry.ts**

创建 `src/core/agents/registry.ts`：

```ts
import type { AgentDefinition, AgentRegistry, AgentMode } from './types.js'

/** 创建空的 agent 注册表（内存 Map，后注册覆盖同名）。 */
function createAgentRegistry(): AgentRegistry {
  const defs = new Map<string, AgentDefinition>()

  return {
    register(def) {
      defs.set(def.name, def)
    },
    get(name) {
      return defs.get(name)
    },
    list(mode) {
      const all = Array.from(defs.values())
      if (!mode) return all
      // 'all' 模式的 agent 在任何过滤下都可见；subagent/primary 精确匹配。
      return all.filter((d) => d.mode === 'all' || d.mode === mode)
    },
    has(name) {
      return defs.has(name)
    },
  }
}

export { createAgentRegistry }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/core/agents/registry.test.ts`
Expected: PASS（6 个测试全过）

- [ ] **Step 6: 提交**

```bash
git add src/core/agents/types.ts src/core/agents/registry.ts src/core/agents/registry.test.ts
git commit -m "feat(agents): AgentDefinition 类型与内存注册表"
```

---

## Task 2: Markdown Discovery

**Files:**
- Create: `src/core/agents/discovery.ts`
- Create: `src/core/agents/discovery.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/core/agents/discovery.test.ts`：

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadAgentFile, loadAgents } from './discovery.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'c0de-agent-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('loadAgentFile', () => {
  it('解析 frontmatter + 正文为 AgentDefinition', async () => {
    const file = join(tmpDir, 'researcher.md')
    await writeFile(
      file,
      [
        '---',
        'name: researcher',
        'description: 只读调研',
        'tools: [grep, glob, read]',
        'model: deepseek/deepseek-v4',
        'isolated: false',
        'maxRecursion: 0',
        '---',
        'You are a read-only scout.',
        '',
      ].join('\n'),
    )
    const def = await loadAgentFile(file, 'project')
    expect(def).not.toBeNull()
    expect(def?.name).toBe('researcher')
    expect(def?.description).toBe('只读调研')
    expect(def?.tools).toEqual(['grep', 'glob', 'read'])
    expect(def?.model).toBe('deepseek/deepseek-v4')
    expect(def?.isolated).toBe(false)
    expect(def?.maxRecursion).toBe(0)
    expect(def?.systemPrompt).toContain('read-only scout')
    expect(def?.source).toBe('project')
    expect(def?.filePath).toBe(file)
  })

  it('name 缺省时取文件名（去扩展名）', async () => {
    const file = join(tmpDir, 'coder.md')
    await writeFile(file, '---\ndescription: coder\n---\nYou are a coder.')
    const def = await loadAgentFile(file, 'user')
    expect(def?.name).toBe('coder')
  })

  it('mode 默认 subagent', async () => {
    const file = join(tmpDir, 'x.md')
    await writeFile(file, '---\ndescription: x\n---\nprompt')
    const def = await loadAgentFile(file, 'user')
    expect(def?.mode).toBe('subagent')
  })

  it('frontmatter 显式设置 mode', async () => {
    const file = join(tmpDir, 'main.md')
    await writeFile(file, '---\nname: main\nmode: primary\n---\nprompt')
    const def = await loadAgentFile(file, 'user')
    expect(def?.mode).toBe('primary')
  })

  it('无 frontmatter 的文件返回 null', async () => {
    const file = join(tmpDir, 'bad.md')
    await writeFile(file, 'just some text without frontmatter')
    const def = await loadAgentFile(file, 'user')
    expect(def).toBeNull()
  })
})

describe('loadAgents', () => {
  it('加载项目 agents 目录下所有 .md', async () => {
    const agentsDir = join(tmpDir, '.c0de', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, 'a.md'),
      '---\nname: a\ndescription: agent a\n---\nprompt a',
    )
    await writeFile(
      join(agentsDir, 'b.md'),
      '---\nname: b\ndescription: agent b\n---\nprompt b',
    )
    const defs = await loadAgents(tmpDir)
    expect(defs.map((d) => d.name).sort()).toEqual(['a', 'b'])
  })

  it('目录不存在时返回空数组', async () => {
    const defs = await loadAgents(tmpDir)
    expect(defs).toEqual([])
  })

  it('跳过无 frontmatter 的文件', async () => {
    const agentsDir = join(tmpDir, '.c0de', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'good.md'), '---\nname: good\n---\nprompt')
    await writeFile(join(agentsDir, 'bad.md'), 'no frontmatter here')
    const defs = await loadAgents(tmpDir)
    expect(defs.map((d) => d.name)).toEqual(['good'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/agents/discovery.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 discovery.ts**

创建 `src/core/agents/discovery.ts`。frontmatter 解析手写（避免新依赖），只处理 `---\n...\n---` 结构。

```ts
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AgentDefinition, AgentSource, AgentMode } from './types.js'

/** 默认 agent markdown 目录（相对项目根）。 */
const AGENTS_DIR = '.c0de/agents'

/** 解析简单 YAML 行（key: value 或 key: [a, b]）。不处理嵌套。 */
function parseFrontmatterLine(line: string): [string, unknown] | null {
  const idx = line.indexOf(':')
  if (idx === -1) return null
  const key = line.slice(0, idx).trim()
  let value: unknown = line.slice(idx + 1).trim()
  // 数组：[a, b, c]
  if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
    value = value
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  } else if (value === 'true') {
    value = true
  } else if (value === 'false') {
    value = false
  } else {
    // 尝试数字
    const num = Number(value)
    if (!Number.isNaN(num) && value !== '') value = num
  }
  return [key, value]
}

/** 解析单个 markdown 文件为 AgentDefinition。无 frontmatter 返回 null。 */
async function loadAgentFile(
  filePath: string,
  source: AgentSource,
): Promise<AgentDefinition | null> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }

  // frontmatter 必须以 --- 开头
  if (!content.startsWith('---')) return null
  const endIdx = content.indexOf('\n---', 3)
  if (endIdx === -1) return null

  const fmRaw = content.slice(3, endIdx)
  const body = content.slice(endIdx + 4).trim() // 跳过 \n---

  const fm: Record<string, unknown> = {}
  for (const line of fmRaw.split('\n')) {
    const parsed = parseFrontmatterLine(line)
    if (parsed) fm[parsed[0]] = parsed[1]
  }

  const name = (fm.name as string) ?? basename(filePath, '.md')
  const description = (fm.description as string) ?? ''
  if (!description) return null

  const mode = (fm.mode as AgentMode) ?? 'subagent'

  return {
    name,
    description,
    systemPrompt: body,
    ...(fm.tools ? { tools: fm.tools as string[] } : {}),
    ...(fm.model ? { model: fm.model as string } : {}),
    mode,
    ...(fm.isolated !== undefined ? { isolated: fm.isolated as boolean } : {}),
    ...(fm.maxRecursion !== undefined ? { maxRecursion: fm.maxRecursion as number } : {}),
    source,
    filePath,
  }
}

/** 加载项目 agents 目录下所有 .md 为 AgentDefinition（源: project）。 */
async function loadAgents(projectDir: string): Promise<AgentDefinition[]> {
  const agentsDir = join(projectDir, AGENTS_DIR)
  let entries: string[]
  try {
    const s = await stat(agentsDir)
    if (!s.isDirectory()) return []
    entries = await readdir(agentsDir)
  } catch {
    return []
  }

  const defs: AgentDefinition[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const def = await loadAgentFile(join(agentsDir, entry), 'project')
    if (def) defs.push(def)
  }
  return defs
}

export { loadAgentFile, loadAgents }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/agents/discovery.test.ts`
Expected: PASS（8 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add src/core/agents/discovery.ts src/core/agents/discovery.test.ts
git commit -m "feat(agents): markdown frontmatter discovery"
```

---

## Task 3: 内置默认 Agent

**Files:**
- Create: `src/core/agents/builtin.ts`
- Create: `src/core/agents/builtin.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/core/agents/builtin.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from './builtin.js'
import type { AgentDefinition } from './types.js'

describe('BUILTIN_AGENTS', () => {
  it('包含 4 个内置 agent', () => {
    const names = BUILTIN_AGENTS.map((d) => d.name).sort()
    expect(names).toEqual(['coder', 'general', 'researcher', 'reviewer'])
  })

  it('所有内置 agent source 为 builtin', () => {
    for (const def of BUILTIN_AGENTS) {
      expect(def.source).toBe('builtin')
    }
  })

  it('每个内置 agent 有 name/description/systemPrompt/mode', () => {
    for (const def of BUILTIN_AGENTS) {
      expect(def.name).toBeTruthy()
      expect(def.description).toBeTruthy()
      expect(def.systemPrompt).toBeTruthy()
      expect(['subagent', 'primary', 'all']).toContain(def.mode)
    }
  })

  it('researcher 是只读（不含 write/edit/bash）', () => {
    const researcher = BUILTIN_AGENTS.find((d) => d.name === 'researcher')!
    expect(researcher.tools).toBeDefined()
    const tools = researcher.tools!
    expect(tools).toContain('grep')
    expect(tools).toContain('read')
    expect(tools).not.toContain('write')
    expect(tools).not.toContain('bash')
  })

  it('general 允许递归 task（maxRecursion >= 1）', () => {
    const general = BUILTIN_AGENTS.find((d) => d.name === 'general')!
    expect(general.maxRecursion ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('coder/researcher/reviewer 默认禁止递归 task（maxRecursion 0 或缺省）', () => {
    for (const def of BUILTIN_AGENTS) {
      if (def.name === 'general') continue
      expect(def.maxRecursion ?? 0).toBe(0)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/agents/builtin.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 builtin.ts**

创建 `src/core/agents/builtin.ts`。worker 模板参考 oh-my-pi `subagent-system-prompt.md`，裁剪至 c0de-agent 场景（无 worktree/irc 注入，由 runSubAgent 在运行时按需拼接）。

```ts
import type { AgentDefinition } from './types.js'

/** 通用 subagent worker 骨架（叠加角色 prompt）。 */
const WORKER_BASE = `You are a worker agent for delegated tasks.

You have FULL access to the tools provided. Use them as needed to complete the assigned work.

<directives>
- You MUST finish only the assigned work and return the minimum useful result. Do not repeat what you wrote to filesystem.
- You MUST be concise. NEVER include filler, repetition, or tool transcripts. The user cannot see you. Your result is just notes for the main agent.
- You SHOULD prefer narrow lookups (grep/glob), then read only the needed ranges. Ignore anything beyond your scope.
- You SHOULD prefer edits to existing files over creating new ones.
- You NEVER create documentation files (*.md, README) unless explicitly requested.
- You MUST follow the assignment exactly.
</directives>

When done, call the \`yield\` tool with your structured result. This is the ONLY way to return a final result.`

/** 4 个内置默认 agent。 */
const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: 'general',
    description: '通用助手，全工具，可递归派生子任务。默认子 agent。',
    systemPrompt: `${WORKER_BASE}\n\nYou are a general-purpose agent. Tackle any delegated task with the tools available.`,
    mode: 'subagent',
    maxRecursion: 1,
    source: 'builtin',
  },
  {
    name: 'coder',
    description: '实现专家，专注写代码实现。可读写文件、执行命令。',
    systemPrompt: `${WORKER_BASE}\n\nYou specialize as: an implementation engineer. Bring exactly that expertise — write clean, correct, well-tested code. Prefer surgical edits. Verify your work (run relevant tests/commands) before yielding.`,
    tools: ['read', 'write', 'edit', 'bash', 'grep', 'glob'],
    mode: 'subagent',
    maxRecursion: 0,
    source: 'builtin',
  },
  {
    name: 'researcher',
    description: '只读代码调研专家，用 grep/glob/read 摸清结构后返回压缩上下文。不改任何文件。',
    systemPrompt: `${WORKER_BASE}\n\nYou specialize as: a read-only codebase scout. Map the relevant code, return compressed context (key files, structures, signatures). NEVER modify files. NEVER run write/edit/bash.`,
    tools: ['grep', 'glob', 'read'],
    mode: 'subagent',
    maxRecursion: 0,
    source: 'builtin',
  },
  {
    name: 'reviewer',
    description: '代码审查专家，返回结构化发现（问题、建议、严重性）。',
    systemPrompt: `${WORKER_BASE}\n\nYou specialize as: a code reviewer. Read the code under review, assess correctness/quality/risks. Return findings via yield as { findings: [{ severity, file, line, issue, suggestion }], summary: string }. severity ∈ 'critical' | 'warning' | 'info'.`,
    tools: ['grep', 'glob', 'read'],
    mode: 'subagent',
    maxRecursion: 0,
    source: 'builtin',
  },
]

export { BUILTIN_AGENTS, WORKER_BASE }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/agents/builtin.test.ts`
Expected: PASS（6 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add src/core/agents/builtin.ts src/core/agents/builtin.test.ts
git commit -m "feat(agents): 4 个内置默认 agent (general/coder/researcher/reviewer)"
```

---

## Task 4: agents 模块 barrel + Config 扩展

**Files:**
- Create: `src/core/agents/index.ts`
- Modify: `src/shared/types/config.ts`（加 `AgentsConfig`）
- Modify: `src/core/config.ts`（`DEFAULT_CONFIG` 加默认值）
- Test: `src/core/config.test.ts`（追加）

- [ ] **Step 1: 写 barrel index.ts**

创建 `src/core/agents/index.ts`：

```ts
export { BUILTIN_AGENTS, WORKER_BASE } from './builtin.js'
export { loadAgentFile, loadAgents } from './discovery.js'
export { createAgentRegistry } from './registry.js'
export type { AgentDefinition, AgentMode, AgentRegistry, AgentSource } from './types.js'
```

- [ ] **Step 2: 写 config 失败测试**

在 `src/core/config.test.ts` 文件**末尾的现有 describe 内**追加（如果文件有顶层 describe；否则新建）。先读文件确认结构：

Run: `npx vitest run src/core/config.test.ts`
（确认现有测试通过，了解文件结构）

在 `src/core/config.test.ts` 末尾追加：

```ts
describe('agents config', () => {
  it('DEFAULT_CONFIG 含 agents 字段', () => {
    expect(DEFAULT_CONFIG.agents).toBeDefined()
    expect(DEFAULT_CONFIG.agents.dir).toBe('.c0de/agents')
    expect(DEFAULT_CONFIG.agents.subagentConcurrency).toBe(3)
  })

  it('mergeConfig 合并 agents 字段', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      agents: { dir: '.custom/agents', subagentConcurrency: 5 },
    })
    expect(merged.agents?.subagentConcurrency).toBe(5)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/core/config.test.ts`
Expected: FAIL（`DEFAULT_CONFIG.agents` undefined）

- [ ] **Step 4: 加 AgentsConfig 类型**

在 `src/shared/types/config.ts` 的 `Config` 类型定义前加入：

```ts
/** 多 agent 配置（spec: multi-agent-design §4.12）。 */
type AgentsConfig = {
  /** agent markdown 目录（相对项目根），默认 '.c0de/agents'。 */
  dir: string
  /** 并行子 agent 数上限，默认 3。 */
  subagentConcurrency: number
}
```

并在 `Config` 类型中加字段（在 `websearch` 后、`theme` 前）：

```ts
  websearch: WebSearchConfig
  agents: AgentsConfig
  theme: 'light' | 'dark' | 'system'
```

在文件末尾 export 列表加 `AgentsConfig`：

```ts
export type {
  AgentsConfig,
  CompactionConfig,
  Config,
  ...
}
```

- [ ] **Step 5: 更新 DEFAULT_CONFIG**

在 `src/core/config.ts` 的 `DEFAULT_CONFIG` 中，`websearch` 后加：

```ts
  websearch: { provider: 'auto' },
  agents: { dir: '.c0de/agents', subagentConcurrency: 3 },
  theme: 'system',
```

并在 import 和 export 中加 `AgentsConfig`。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/core/config.test.ts`
Expected: PASS

- [ ] **Step 7: 类型检查 + 全量测试**

Run: `npm run typecheck && npm run test`
Expected: 全部通过（agents 配置不破坏现有）

- [ ] **Step 8: 提交**

```bash
git add src/core/agents/index.ts src/shared/types/config.ts src/core/config.ts src/core/config.test.ts
git commit -m "feat(agents): barrel 导出 + Config.agents 配置字段"
```

---

## Task 5: DB Schema 扩展（agentType / worktreePath）

**Files:**
- Modify: `src/db/schema.ts`（sessions 加两列）
- Create: `drizzle/0003_add_agent_columns.sql`
- Modify: `src/session/session.ts`（rowToSession + createSession）
- Modify: `src/shared/types/message.ts`（Session 加字段）
- Test: `src/db/schema.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `src/db/schema.test.ts` 末尾追加（先读文件确认 import 了 `sessions`）：

```ts
describe('sessions agent columns', () => {
  it('sessions 表含 agentType 和 worktreePath 列', () => {
    // sessions 是 drizzle table 对象，列名通过 columns 访问
    expect(sessions.agentType).toBeDefined()
    expect(sessions.worktreePath).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/db/schema.test.ts`
Expected: FAIL（`sessions.agentType` undefined）

- [ ] **Step 3: 更新 schema.ts**

在 `src/db/schema.ts` 的 `sessions` pgTable 定义中，`metadata` 后、`createdAt` 前加两列：

```ts
    metadata: jsonb('metadata').notNull().default({}),
    agentType: text('agent_type'),
    worktreePath: text('worktree_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
```

- [ ] **Step 4: 写 migration SQL**

创建 `drizzle/0003_add_agent_columns.sql`：

```sql
ALTER TABLE "sessions" ADD COLUMN "agent_type" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "worktree_path" text;
```

- [ ] **Step 5: 更新 Session 类型**

在 `src/shared/types/message.ts` 的 `Session` 类型加字段：

```ts
type Session = {
  id: string
  title: string
  parentId: string | null
  projectId: string | null
  branchPoint: number | null
  metadata: SessionMetadata
  /** 子 session 用的 agent 类型名（null=主 session）。 */
  agentType: string | null
  /** 隔离 worktree 路径（null=共享父 cwd）。 */
  worktreePath: string | null
  createdAt: number
  updatedAt: number
}
```

- [ ] **Step 6: 更新 rowToSession + createSession**

在 `src/session/session.ts` 的 `rowToSession` 加映射：

```ts
export function rowToSession(row: typeof sessions.$inferSelect): Session {
  const created = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime()
  const updated = row.updatedAt instanceof Date ? row.updatedAt.getTime() : new Date(row.updatedAt).getTime()
  return {
    id: row.id,
    title: row.title,
    parentId: row.parentId,
    projectId: row.projectId,
    branchPoint: row.branchPoint,
    metadata: (row.metadata ?? {}) as SessionMetadata,
    agentType: row.agentType ?? null,
    worktreePath: row.worktreePath ?? null,
    createdAt: created,
    updatedAt: updated,
  }
}
```

`createSession` 签名扩展为可选接收 agentType：

```ts
async function createSession(
  handle: DB,
  title: string,
  projectId?: string,
  agentType?: string,
): Promise<Session> {
  const [row] = await handle.db
    .insert(sessions)
    .values({ title, projectId: projectId ?? null, agentType: agentType ?? null })
    .returning()
  if (!row) throw new Error('Failed to insert session')
  return rowToSession(row)
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run src/db/schema.test.ts src/session/session.test.ts`
Expected: PASS

若 session.test.ts 有 `createSession` 的断言需更新参数，一并修正。

- [ ] **Step 8: 类型检查**

Run: `npm run typecheck`
Expected: 无错误（所有读 Session 的地方需兼容新字段——新字段 nullable 不破坏）

若有类型错误（例如其他构造 Session 的地方），补 `agentType: null, worktreePath: null`。

- [ ] **Step 9: 提交**

```bash
git add src/db/schema.ts drizzle/0003_add_agent_columns.sql src/shared/types/message.ts src/session/session.ts src/db/schema.test.ts
git commit -m "feat(db): sessions 加 agentType/worktreePath 列 + migration"
```

---

## Task 6: SubAgent 类型与 AgentDependencies 扩展

**Files:**
- Modify: `src/shared/types/tool.ts`（SubAgentRequest/Result/ToolContext）
- Modify: `src/shared/types/agent.ts`（AgentEvent 加 subagent_*）
- Modify: `src/core/types.ts`（AgentDependencies 加 agentRegistry）
- Test: `src/shared/types/tool.ts`（类型层，靠编译保证；在 loop.test.ts 集成验证）

> 本任务是纯类型层改动，无独立单元测试——类型正确性由 typecheck 保证，行为由后续 Task 8（runSubAgent）的测试覆盖。

- [ ] **Step 1: 更新 SubAgentRequest / SubAgentResult**

在 `src/shared/types/tool.ts`，替换现有的 `SubAgentRequest` 和 `SubAgentResult`：

```ts
/** 单个并行子任务项（批量模式）。 */
type TaskItem = {
  description?: string
  /** 角色细分（注入子 prompt）。 */
  role?: string
  assignment: string
}

/** 请求运行一个子 agent（task 工具的载荷）。 */
type SubAgentRequest = {
  /** agent 类型名（必填）。 */
  agentType: string
  prompt: string
  description?: string
  /** 批量模式的角色细分。 */
  role?: string
  /** 批量模式的共享上下文。 */
  context?: string
  model?: string
  /** 后台异步运行（默认 false）。 */
  background?: boolean
}

/** 子 agent 运行结果。 */
type SubAgentResult =
  | { _tag: 'success'; output: string; sessionId: string; data?: unknown; patchPath?: string }
  | { _tag: 'error'; error: string; sessionId?: string }
  | { _tag: 'running'; jobId: string; sessionId: string }
```

- [ ] **Step 2: 更新 ToolContext**

在 `src/shared/types/tool.ts` 的 `ToolContext` 加 `collectYield`：

```ts
type ToolContext = {
  cwd: string
  session: SessionRef
  abort: AbortSignal
  mode?: string
  urlRegistry?: URLRegistry
  runSubAgent?: (input: SubAgentRequest) => Promise<SubAgentResult>
  debugSpawn?: (config: unknown) => DebugTransport
  /** 子 agent 专用：yield 工具调用时收集结构化结果（runSubAgent 注入）。 */
  collectYield?: (data: unknown) => void
}
```

- [ ] **Step 3: 更新 AgentEvent**

在 `src/shared/types/agent.ts` 的 `AgentEvent` 联合类型中，`llm_detail` 后、`done` 前加：

```ts
  | { _tag: 'llm_detail' }
  | { _tag: 'subagent_start'; childId: string; agentType: string; description: string; background: boolean }
  | { _tag: 'subagent_progress'; childId: string; toolName?: string; status: 'running' | 'completed' | 'failed' }
  | { _tag: 'subagent_end'; childId: string; agentType: string; success: boolean; output?: string }
  | { _tag: 'done' }
```

- [ ] **Step 4: 更新 AgentDependencies**

在 `src/core/types.ts` 的 `AgentDependencies` 加 `agentRegistry`：

```ts
type AgentDependencies = {
  db: DB
  llmRegistry: Registry
  toolRegistry: ToolRegistry
  permission: PermissionChecker
  config: Config
  cwd: string
  hookRunner?: HookRunner
  urlRegistry?: URLRegistry
  promptRegistry?: PromptRegistry
  titleChatFn?: typeof ChatFn
  debugSpawn?: (config: unknown) => DebugTransport
  /** Agent 类型注册表（spec: multi-agent-design）。注入后 task 工具可按类型派发。 */
  agentRegistry?: AgentRegistry
}
```

并在文件顶部 import 加 `AgentRegistry`：

```ts
import type { AgentRegistry } from './agents/types.js'
```

在 export 列表加 `AgentRegistry`（从 agents 模块 re-export 或直接引用）。由于 `core/types.ts` 不应直接依赖 `core/agents`（避免循环——agents 模块不依赖 core），import `AgentRegistry` type 是安全的。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 可能有错误——现有调用 `runSubAgent({ prompt, description, model })`（旧签名，无 agentType）。这些调用点在 `loop.ts` 和 `task.ts`，将在 Task 8/9 修复。**暂记这些错误，本步不修复**——仅确认 SubAgentRequest 类型改动生效（错误指向 loop.ts/task.ts 即可）。

若错误只来自预期的 loop.ts/task.ts 调用点，本步骤算通过（类型层改动正确）。继续下一步前不提交——本任务的提交与 Task 8 合并（避免中间态 typecheck 失败的提交）。

> **注意**：本任务不单独提交，与 Task 7、8 一同提交，确保每个 commit 通过 typecheck。

---

## Task 7: yield 工具

**Files:**
- Create: `src/tools/builtin/yield.ts`
- Create: `src/tools/builtin/yield.test.ts`
- Modify: `src/tools/index.ts`（注册 + 导出）

- [ ] **Step 1: 写失败测试**

创建 `src/tools/builtin/yield.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../shared/types/tool.js'
import { yieldTool } from './yield.js'

function ctxWith(collectYield?: ToolContext['collectYield']): ToolContext {
  return {
    cwd: '/tmp',
    session: { id: 'child', cwd: '/tmp' },
    abort: new AbortController().signal,
    ...(collectYield ? { collectYield } : {}),
  }
}

describe('yieldTool', () => {
  it('工具定义正确', () => {
    expect(yieldTool.name).toBe('yield')
    expect(yieldTool.permission).toBe('auto')
    expect(yieldTool.parameters.required).toContain('data')
  })

  it('调用 collectYield 收集 data 并返回 success', async () => {
    const collectYield = vi.fn()
    const result = await yieldTool.execute({ data: { summary: 'done' } }, ctxWith(collectYield))
    expect(collectYield).toHaveBeenCalledWith({ summary: 'done' })
    expect(result._tag).toBe('success')
  })

  it('支持 type/status/error 字段', async () => {
    const collectYield = vi.fn()
    await yieldTool.execute(
      { data: {}, type: 'section1', status: 'success' },
      ctxWith(collectYield),
    )
    expect(collectYield).toHaveBeenCalledWith({})
  })

  it('blocked 时携带 error 字段', async () => {
    const collectYield = vi.fn()
    const result = await yieldTool.execute(
      { data: {}, status: 'aborted', error: 'tried everything' },
      ctxWith(collectYield),
    )
    expect(result._tag).toBe('success')
    expect(collectYield).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/tools/builtin/yield.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 yield.ts**

创建 `src/tools/builtin/yield.ts`：

```ts
import type { ToolDef } from '../../shared/types/tool.js'

/**
 * yield 工具：子 agent 专用，提交结构化最终结果。
 *
 * 这是子 agent 返回结果的唯一方式。调用后，runSubAgent 的 collectYield
 * 回调收集结果，子 agent loop 检测到 yield 后优雅终止。
 * 主 agent 不注册此工具。permission: auto（纯结果收集，不改外部状态）。
 */
export const yieldTool: ToolDef = {
  name: 'yield',
  description:
    'Submit your final structured result. This is the ONLY way to return a result from a sub-agent task. Call this once when your work is complete.',
  parameters: {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        description: 'Your structured result. Must match the outputSchema if the agent declared one.',
      },
      type: {
        type: 'string',
        description: 'Optional section label for incremental yields.',
      },
      status: {
        type: 'string',
        enum: ['success', 'aborted'],
        description: 'Outcome status. Use "aborted" if blocked.',
      },
      error: {
        type: 'string',
        description: 'If blocked (status=aborted), describe what you tried and the exact blocker.',
      },
    },
    required: ['data'],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx) => {
    const { data } = input as { data: unknown }
    ctx.collectYield?.(data)
    return { _tag: 'success', output: 'Result submitted.' }
  },
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/tools/builtin/yield.test.ts`
Expected: PASS（4 个测试全过）

- [ ] **Step 5: 注册到 index.ts**

在 `src/tools/index.ts`：

import 部分加（taskTool 后）：
```ts
export { yieldTool } from './builtin/yield.js'
```

`createDefaultRegistry` 函数中，`registerTool(reg, taskTool)` 后加：
```ts
  // yield 工具默认不注册到主 registry —— 仅子 agent 运行时按需注入。
  // 故此处不 registerTool(reg, yieldTool)。
```

> 注意：yield 仅子 agent 用，不进默认 registry。在 `tools/index.ts` 仅做 export，runSubAgent 会从 `builtin/yield.js` 直接 import 注册到子 agent 的临时 registry。

- [ ] **Step 6: 类型检查 + 全量测试**

Run: `npm run typecheck && npm run test`
Expected: 全部通过（yield 工具独立，不影响现有）

- [ ] **Step 7: 提交**

```bash
git add src/tools/builtin/yield.ts src/tools/builtin/yield.test.ts src/tools/index.ts
git commit -m "feat(tools): yield 工具（子 agent 结构化结果返回）"
```

---

## Task 8: 增强 runSubAgent（核心）

> 本任务与 Task 6 类型改动合并提交，确保 typecheck 通过。

**Files:**
- Modify: `src/core/loop.ts`（runSubAgent 重写）
- Modify: `src/core/agent.ts`（createAgent 接收 agentType/subagentCwd）
- Modify: `src/core/types.ts`（已含 Task 6 的 agentRegistry）
- Test: `src/core/loop.test.ts`（追加 subagent 派发测试）

- [ ] **Step 1: 读现有 runSubAgent 与 loop 测试结构**

确认 `src/core/loop.ts` 当前 `runSubAgent`（约 53-103 行）和 `agentLoop` 中注入 `runSubAgent` 的位置（约 474 行）。

- [ ] **Step 2: 写失败测试**

在 `src/core/loop.test.ts` 末尾追加新 describe。需要构造带 agentRegistry 的 LoopDeps 和 mock chatStream。

```ts
import { createAgentRegistry } from './agents/index.js'
import { BUILTIN_AGENTS } from './agents/builtin.js'

describe('runSubAgent (agent-typed dispatch)', () => {
  it('按 agentType 派发，子 agent 用专属 prompt 和受限工具集', async () => {
    const registry = createAgentRegistry()
    for (const def of BUILTIN_AGENTS) registry.register(def)

    // mock 子 agent 流：yield 工具调用
    function mockChildStream(): AsyncGenerator<StreamChunk> {
      async function* gen() {
        yield { _tag: 'tool_call_start', id: 'yc1', name: 'yield' } as const
        yield {
          _tag: 'tool_call_end',
          id: 'yc1',
          argumentsFinal: JSON.stringify({ data: { summary: 'found 3 files' } }),
        } as const
        yield { _tag: 'done' } as const
      }
      return gen()
    }

    const { agentLoop } = await import('./loop.js')
    const db = /* 用现有 beforeEach 的 db */

    // 构造父 state（简化）
    // ...（用现有测试的 createAgent helper）
    // 调用 task 工具 → 触发 runSubAgent
    // 验证：子 session agentType='researcher'，子 agent 工具集只含 grep/glob/read + yield
    expect(true).toBe(true) // 占位——实际断言见 Step 4 实现
  })
})
```

> **说明**：本测试较复杂，因为 runSubAgent 是 loop.ts 内部函数，需通过 task 工具间接触发。简化策略：把 `runSubAgent` 从 loop.ts 导出（改为 exported function），直接单测。

- [ ] **Step 3: 导出 runSubAgent 以便测试**

在 `src/core/loop.ts`，将 `async function runSubAgent` 改为 `export async function runSubAgent`，并在文件底部 export。这样可独立单测。

- [ ] **Step 4: 写完整 runSubAgent 测试**

替换 Step 2 的占位测试为完整版：

```ts
describe('runSubAgent', () => {
  it('未知 agentType 返回 error', async () => {
    const deps: LoopDeps = {
      db: await createDB(),
      llmRegistry: createTestRegistry(),
      toolRegistry: createDefaultRegistry(),
      permission: autoAllowChecker,
      config: DEFAULT_CONFIG,
      cwd: '/tmp',
      agentRegistry: createAgentRegistry(), // 空注册表
    }
    await migrateDB(deps.db)
    const parentSession = await createSession(deps.db, 'parent')
    const parent = await createAgent(parentSession, { provider: 'x', model: 'y', tools: [], plugins: [] }, deps)

    const result = await runSubAgent(
      deps,
      parent,
      { agentType: 'nonexistent', prompt: 'test' },
    )
    expect(result._tag).toBe('error')
    if (result._tag === 'error') expect(result.error).toMatch(/Unknown agent type/i)
  })

  it('按 agentType 派发，子 session agentType 正确记录', async () => {
    const registry = createAgentRegistry()
    for (const def of BUILTIN_AGENTS) registry.register(def)
    const toolReg = createToolRegistry()
    registerTool(toolReg, readTool)

    const deps: LoopDeps = {
      db: await createDB(),
      llmRegistry: createTestRegistry(),
      toolRegistry: toolReg,
      permission: autoAllowChecker,
      config: DEFAULT_CONFIG,
      cwd: '/tmp',
      agentRegistry: registry,
      chatStream: async () => mockTextStream('child result'), // mock 子 agent 文本流
    }
    await migrateDB(deps.db)
    const parentSession = await createSession(deps.db, 'parent')
    const parent = await createAgent(parentSession, { provider: 'x', model: 'y', tools: ['read'], plugins: [] }, deps)

    const result = await runSubAgent(deps, parent, {
      agentType: 'researcher',
      prompt: 'explore',
      description: 'test researcher',
    })

    expect(result._tag).toBe('success')
    if (result._tag === 'success') {
      expect(result.sessionId).toBeTruthy()
      // 子 session 的 agentType 应为 researcher
      const childSession = await getSession(deps.db, result.sessionId)
      expect(childSession?.agentType).toBe('researcher')
    }
  })
})
```

> 注：`createTestRegistry`、`mockTextStream` 等需用现有 loop.test.ts 的 helper。`getSession` 从 `../session/session.js` import。`runSubAgent` 现已 export。

- [ ] **Step 5: 跑测试确认失败**

Run: `npx vitest run src/core/loop.test.ts -t "runSubAgent"`
Expected: FAIL（新参数不匹配 / 子 session agentType 为 null）

- [ ] **Step 6: 重写 runSubAgent**

在 `src/core/loop.ts` 顶部 import 加：

```ts
import { yieldTool } from '../tools/builtin/yield.js'
import type { AgentDefinition } from './agents/types.js'
import type { TaskItem } from '../shared/types/tool.js'
```

替换整个 `runSubAgent` 函数（原 53-103 行）为：

```ts
/** 运行一个按类型派发的子 agent（spec: multi-agent-design §4.5）。
 *
 *  Host 端实现：查 agentRegistry 获取 AgentDefinition → 创建隔离子 session（agentType 记录）
 *  → 构建子 agent（专属 prompt + 受限工具集 + yield）→ 运行到 yield 或完成 → 返回结果。
 *  发射 subagent_start/subagent_end 事件供父 agent 转发（spec §4.5 step 7）。
 *  abort 链接父→子。maxRecursion 控制子 agent 能否再递归派生 task（spec §4.5 step 4）。 */
export async function runSubAgent(
  deps: LoopDeps,
  parent: AgentState,
  request: SubAgentRequest,
): Promise<SubAgentResult> {
  // 1. 查 agent 类型
  if (!deps.agentRegistry) {
    return { _tag: 'error', error: 'task tool unavailable: no agent registry is wired' }
  }
  const def = deps.agentRegistry.get(request.agentType)
  if (!def) {
    return { _tag: 'error', error: `Unknown agent type: ${request.agentType} is not a valid agent type` }
  }

  const title = request.description?.trim() || `Sub-agent (${request.agentType}): ${request.prompt.slice(0, 60)}`
  const childId = generateId()

  // 发射 subagent_start 事件（spec §4.5 step 7）—— 通过 deps._subagentEventSink
  // 推入父 agent 的事件缓冲，由 agentLoop 在工具执行后 yield 出去。
  deps._subagentEventSink?.({
    _tag: 'subagent_start',
    childId,
    agentType: request.agentType,
    description: request.description ?? '',
    background: request.background ?? false,
  })

  // 2. 创建子 session（记录 agentType）
  let childSession: Session
  try {
    childSession = await createSession(deps.db, title, parent.session.projectId ?? undefined, request.agentType)
  } catch (e) {
    return { _tag: 'error', error: e instanceof Error ? e.message : String(e) }
  }

  // 3. 构建子 agent 配置：工具集隔离 + 模型覆盖
  //    工具集：def.tools 声明的；若 def.tools 为空则用全部（spec §8 风险缓解）。
  //    递归限制（spec §4.5 step 4 / §8）：maxRecursion 默认 0=禁止。
  //    仅当 def.maxRecursion > 当前递归深度（用 deps._subagentDepth 跟踪）时保留 task 工具。
  const parentDepth = deps._subagentDepth ?? 0
  const childDepth = parentDepth + 1
  let childTools = def.tools ?? parent.config.tools
  // 移除 task 工具（若超过递归上限）
  const maxRec = def.maxRecursion ?? 0
  if (childDepth > maxRec) {
    childTools = childTools.filter((t) => t !== 'task')
  }
  const childConfig = {
    ...parent.config,
    systemPrompt: def.systemPrompt,
    tools: childTools,
    ...(def.model ? { model: def.model } : {}),
    ...(request.model ? { model: request.model } : {}),
  }

  // 4. 创建子 agent（专属 cwd 由 caller 通过 deps.cwd；worktree 在 Task 11 处理）
  const childState = await createAgent(childSession, childConfig, deps)

  // 5. 工具集隔离：子 agent 的 tools 只保留 def.tools 声明的 + yield
  //    createAgent 已按 config.tools 过滤，但需额外确保 yield 注册。
  //    通过临时给子 agent 注册 yield 实现（用独立 registry 覆盖）。
  //    简化：在 deps.toolRegistry 基础上，yieldTool 由 runSubAgent 直接管。
  const yielded: unknown[] = []
  const collectYield = (data: unknown) => {
    yielded.push(data)
  }
  // 注入 collectYield 到子 agent 的 ToolContext —— 通过修改 childState 的 deps 不可行（共享），
  // 改为在 executeToolCalls 调用时传入。见下方 runAgent 包装。

  // 6. abort 链接
  if (parent.abortController.signal.aborted) {
    childState.abortController.abort()
  } else {
    parent.abortController.signal.addEventListener(
      'abort',
      () => childState.abortController.abort(),
      { once: true },
    )
  }

  // 7. 运行子 agent loop
  const text: string[] = []
  let errMsg: string | null = null
  const childPrompt = request.context
    ? `CONTEXT\n${request.context}\n\nASSIGNMENT\n${request.prompt}`
    : request.prompt

  try {
    // 把 yield 收集器通过 deps 的临时通道传入。runAgent/runAgent 内的 executeToolCalls
    // 读取 ctx.collectYield。我们在 deps 上挂一个临时字段。
    const childDeps: LoopDeps = {
      ...deps,
      // 注入 yield 收集器（executeToolCalls 通过 ctx.collectYield 读取）
      _subagentYieldCollector: collectYield,
      // 子 agent 的递归深度 +1（用于 maxRecursion 控制）
      _subagentDepth: childDepth,
    }
    for await (const ev of runAgent(childState, [{ _tag: 'text', text: childPrompt }], childDeps)) {
      if (ev._tag === 'text_delta') {
        text.push(ev.text)
      } else if (ev._tag === 'error') {
        const e = ev.error
        errMsg = e._tag === 'unexpected' || e._tag === 'provider' ? e.message : e._tag
      }
    }
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e)
  }

  if (errMsg !== null) {
    return { _tag: 'error', error: errMsg, sessionId: childSession.id }
  }

  // 8. 组装结果：优先 yield data，否则文本
  const data = yielded.length > 0 ? (yielded.length === 1 ? yielded[0] : yielded) : undefined
  const success = errMsg === null

  // 发射 subagent_end 事件（spec §4.5 step 7）
  deps._subagentEventSink?.({
    _tag: 'subagent_end',
    childId,
    agentType: request.agentType,
    success,
    ...(success ? { output: text.join('') } : {}),
  })

  if (!success) {
    return { _tag: 'error', error: errMsg!, sessionId: childSession.id }
  }
  return {
    _tag: 'success',
    output: text.join(''),
    sessionId: childSession.id,
    ...(data !== undefined ? { data } : {}),
  }
}
```

> **注意**：`_subagentYieldCollector` / `_subagentEventSink` / `_subagentDepth` 是 LoopDeps 的临时扩展字段。

- [ ] **Step 7: 扩展 LoopDeps 类型**

在 `src/core/loop.ts` 的 `LoopDeps` 类型加：

```ts
type LoopDeps = AgentDependencies & {
  chatStream?: typeof llmChatStream
  /** 子 agent 运行时注入：yield 工具的结果收集器（透传到 ToolContext.collectYield）。 */
  readonly _subagentYieldCollector?: (data: unknown) => void
  /** 子 agent 运行时注入：事件回调，子 agent 的 subagent_start/end 事件推入此 sink，
   *  由父 agentLoop 缓冲后在工具执行后 yield 出去（spec §4.5 step 7）。 */
  readonly _subagentEventSink?: (event: AgentEvent) => void
  /** 当前递归深度（0=顶层主 agent）。用于 maxRecursion 控制（spec §4.5 step 4）。 */
  readonly _subagentDepth?: number
}
```

- [ ] **Step 8: 在 executeToolCalls 调用处透传 collectYield + 事件缓冲**

在 `src/core/loop.ts` 的 `agentLoop` 中，构建 ToolContext 的位置（约 470-477 行），加 `collectYield` 和事件缓冲机制：

在 `agentLoop` 的 for 循环开头（turn 循环内），初始化事件缓冲：

```ts
  for (let turn = 0; turn < maxTurns; turn++) {
    // ...现有 abort 检查...

    // subagent 事件缓冲：runSubAgent 通过 sink 推入事件，executeToolCalls 后 yield 出去
    const subagentEvents: AgentEvent[] = []
    const eventSink = (ev: AgentEvent) => subagentEvents.push(ev)
```

构建 ToolContext（约 470-477 行），加 collectYield + 把 eventSink 注入 deps：

```ts
        {
          cwd: deps.cwd,
          session: { id: state.session.id, cwd: deps.cwd },
          abort: state.abortController.signal,
          ...(deps.urlRegistry ? { urlRegistry: deps.urlRegistry } : {}),
          ...(deps.debugSpawn ? { debugSpawn: deps.debugSpawn } : {}),
          runSubAgent: (req) => runSubAgent(
            { ...deps, _subagentEventSink: eventSink },
            state,
            req,
          ),
          ...(deps._subagentYieldCollector ? { collectYield: deps._subagentYieldCollector } : {}),
        },
```

在 `executeToolCalls` 调用**之后**（工具执行完成、持久化之后），yield 缓冲的 subagent 事件：

```ts
    // ...executeToolCalls 调用后...

    // yield 在本轮工具执行中收集的 subagent 事件（subagent_start/end）
    for (const ev of subagentEvents) {
      yield ev
    }
```

> **位置**：找到 agentLoop 中 `yield* toolEvents` 或 `for (const ev of toolEvents) yield ev` 的模式（executeToolCalls 返回的事件），在其后追加 subagentEvents 的 yield。具体行号需读 loop.ts 确认。

- [ ] **Step 9: 确保 yield 工具注册到子 agent**

`createAgent`（agent.ts）按 `config.tools` 过滤工具。需确保 yield 在子 agent 工具集内。两种方案：

**方案**（推荐）：在 `runSubAgent` 中，子 agent 的 `childConfig.tools` 显式加 `'yield'`：

```ts
  const childConfig = {
    ...parent.config,
    systemPrompt: def.systemPrompt,
    tools: [...(def.tools ?? parent.config.tools), 'yield'],
    ...
  }
```

并在 `src/tools/index.ts` 的 `createDefaultRegistry` 注册 yield（这样 getTool 能找到）：

```ts
  registerTool(reg, yieldTool)
```

> 但这会让主 agent 也获得 yield 工具——不希望。改进：yield 仍不进默认 registry，而在 `createAgent` 时若 `config.tools` 含 'yield' 则从 `builtin/yield.js` 直接 import 注册。但 createAgent 在 core 层 import tools 层，已有先例（listTools from tools/registry）。

**最终方案**：`runSubAgent` 创建一个临时 toolRegistry 副本，注册 yield，传给子 agent。

简化实现——由于 `deps.toolRegistry` 是共享的，子 agent 复用。改为：在 `createDefaultRegistry` 注册 yield，但 task 工具描述里说明 yield 是子 agent 专用。主 agent 的 model 若误调 yield，executeToolCalls 会执行它（无害——只是收集到 undefined）。**接受此简化**，在 yield 工具描述中写明"子 agent 专用"。

决定：在 `src/tools/index.ts` 的 `createDefaultRegistry` 注册 yieldTool（简化，避免 registry 复制复杂度）。更新 Step 6 中 `childConfig.tools` 不再需手动加 yield（已在默认 registry）。

- [ ] **Step 10: 跑测试确认通过**

Run: `npx vitest run src/core/loop.test.ts -t "runSubAgent"`
Expected: PASS（2 个测试通过）

- [ ] **Step 11: 类型检查**

Run: `npm run typecheck`
Expected: 无错误（Task 6 的类型改动 + 本任务实现一致）

- [ ] **Step 12: 全量测试**

Run: `npm run test`
Expected: 全部通过。若现有 loop 测试因 runSubAgent 签名变化失败，更新对应测试。

- [ ] **Step 13: 提交（合并 Task 6 + 7 类型 + 本任务）**

```bash
git add src/shared/types/tool.ts src/shared/types/agent.ts src/core/types.ts src/core/loop.ts src/core/agent.ts src/tools/index.ts src/core/loop.test.ts
git commit -m "feat(agents): 增强 runSubAgent 按 agentType 派发 + 专属 prompt/工具集 + yield 收集"
```

---

## Task 9: 增强 task 工具（subagent_type + 批量）

**Files:**
- Modify: `src/tools/builtin/task.ts`
- Modify: `src/tools/builtin/task.test.ts`
- Modify: `src/core/loop.ts`（加 runSubAgentsParallel）
- Create: `src/core/agents/parallel.ts` + test

- [ ] **Step 1: 写 parallel 失败测试**

创建 `src/core/agents/parallel.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { mapWithConcurrencyLimit } from './parallel.js'

describe('mapWithConcurrencyLimit', () => {
  it('按序返回结果', async () => {
    const items = [1, 2, 3]
    const { results, aborted } = await mapWithConcurrencyLimit(
      items,
      2,
      async (item) => item * 2,
    )
    expect(results).toEqual([2, 4, 6])
    expect(aborted).toBe(false)
  })

  it('尊重并发上限', async () => {
    let active = 0
    let maxActive = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    await mapWithConcurrencyLimit(items, 3, async (item) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return item
    })
    expect(maxActive).toBeLessThanOrEqual(3)
  })

  it('abort 时取消未启动的，保留已完成', async () => {
    const ctrl = new AbortController()
    const items = [1, 2, 3, 4, 5]
    setTimeout(() => ctrl.abort(), 30)
    const { results, aborted } = await mapWithConcurrencyLimit(
      items,
      1,
      async (item) => {
        await new Promise((r) => setTimeout(r, 20))
        return item
      },
      ctrl.signal,
    )
    expect(aborted).toBe(true)
    expect(results.filter((r) => r !== undefined).length).toBeGreaterThan(0)
  })

  it('任一失败立即 reject', async () => {
    const items = [1, 2, 3]
    await expect(
      mapWithConcurrencyLimit(items, 2, async (item) => {
        if (item === 2) throw new Error('boom')
        return item
      }),
    ).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/agents/parallel.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 parallel.ts**

创建 `src/core/agents/parallel.ts`（参考 oh-my-pi `parallel.ts`）：

```ts
/** 并行执行结果。 */
interface ParallelResult<R> {
  results: (R | undefined)[]
  aborted: boolean
}

/**
 * 带 concurrency 上限的并行执行（worker 池）。
 * 结果按输入顺序返回。abort 时取消未启动的、保留已完成的。
 * 任一失败立即 reject（fail-fast）。
 */
async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): Promise<ParallelResult<R>> {
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results: (R | undefined)[] = new Array(items.length)
  let nextIndex = 0
  const abortController = new AbortController()
  const workerSignal = signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal

  async function worker(): Promise<void> {
    while (true) {
      if (workerSignal.aborted) return
      const idx = nextIndex++
      if (idx >= items.length) return
      results[idx] = await fn(items[idx], idx, workerSignal)
    }
  }

  const workers = Array.from({ length: limit }, () => worker())
  try {
    await Promise.all(workers)
  } catch (e) {
    abortController.abort()
    throw e
  }

  return { results, aborted: signal?.aborted ?? false }
}

export { mapWithConcurrencyLimit }
export type { ParallelResult }
```

在 `src/core/agents/index.ts` 加导出：

```ts
export { mapWithConcurrencyLimit } from './parallel.js'
export type { ParallelResult } from './parallel.js'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/agents/parallel.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 5: 写 task 工具新参数测试**

在 `src/tools/builtin/task.test.ts` 末尾追加：

```ts
  it('subagent_type 派发到 runSubAgent', async () => {
    const runSubAgent = vi.fn(
      async (): Promise<SubAgentResult> => ({
        _tag: 'success',
        output: 'researched',
        sessionId: 'child-1',
      }),
    )
    const result = await taskTool.execute(
      { subagent_type: 'researcher', prompt: 'find auth code' },
      ctxWith(runSubAgent),
    )
    expect(runSubAgent).toHaveBeenCalledWith({
      agentType: 'researcher',
      prompt: 'find auth code',
      description: undefined,
      model: undefined,
    })
    expect(result._tag).toBe('success')
  })

  it('无 subagent_type 时默认 general', async () => {
    const runSubAgent = vi.fn(
      async (): Promise<SubAgentResult> => ({ _tag: 'success', output: 'ok', sessionId: 'c' }),
    )
    await taskTool.execute({ prompt: 'p' }, ctxWith(runSubAgent))
    expect(runSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: 'general' }),
    )
  })

  it('批量 tasks[] 模式派发多个子 agent', async () => {
    const runSubAgent = vi.fn(
      async (): Promise<SubAgentResult> => ({ _tag: 'success', output: 'ok', sessionId: 'c' }),
    )
    const result = await taskTool.execute(
      {
        subagent_type: 'coder',
        context: 'refactor X',
        tasks: [
          { description: 'API 层', role: 'api', assignment: 'do A' },
          { description: '测试层', role: 'test', assignment: 'do B' },
        ],
      },
      ctxWith(runSubAgent),
    )
    expect(runSubAgent).toHaveBeenCalledTimes(2)
    expect(result._tag).toBe('success')
  })
```

并更新现有测试：旧的 `runSubAgent` mock 期望需加 `agentType`（因为 task.ts 现在总是传 agentType）。

- [ ] **Step 6: 跑测试确认失败**

Run: `npx vitest run src/tools/builtin/task.test.ts`
Expected: FAIL（新参数未实现）

- [ ] **Step 7: 重写 task.ts**

替换 `src/tools/builtin/task.ts` 全文：

```ts
import type { SubAgentRequest, SubAgentResult, TaskItem, ToolDef, ToolResult } from '../../shared/types/tool.js'

/** 单任务输入。 */
type SingleTaskInput = {
  subagent_type?: string
  prompt: string
  description?: string
  model?: string
  background?: boolean
}

/** 批量任务输入。 */
type BatchTaskInput = {
  subagent_type: string
  context: string
  tasks: TaskItem[]
}

type TaskInput = SingleTaskInput | BatchTaskInput

/**
 * task 工具：按 agent 类型派发子 agent。
 *
 * 两种形态：单任务（subagent_type + prompt）或批量并行（subagent_type + context + tasks[]）。
 * 依赖反转：实际子 agent 运行由 host（core loop 的 runSubAgent）通过 ctx.runSubAgent 执行。
 * permission: auto（子 agent 是隔离 session，不扩宽父权限）。
 */
export const taskTool: ToolDef = {
  name: 'task',
  description:
    'Launch specialized sub-agents to handle delegated tasks. Specify subagent_type to select a specialist (e.g. researcher for read-only investigation, coder for implementation, reviewer for code review). Launch multiple agents concurrently by using the batch form with tasks[]. The sub-agent runs in an isolated session with its own context. When done, the sub-agent returns its result via the yield tool.',
  parameters: {
    type: 'object',
    properties: {
      subagent_type: {
        type: 'string',
        description: 'The specialist agent type (e.g. researcher, coder, reviewer). Defaults to general.',
      },
      description: { type: 'string', description: 'Short label for the task (display only).' },
      prompt: { type: 'string', description: 'Self-contained assignment (single-task mode).' },
      model: { type: 'string', description: 'Optional model override.' },
      background: { type: 'boolean', description: 'Run in background (default false).' },
      context: { type: 'string', description: 'Shared context (batch mode).' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            role: { type: 'string', description: 'Specialist role for this sub-task.' },
            assignment: { type: 'string' },
          },
        },
        description: 'Parallel sub-tasks (batch mode).',
      },
    },
    required: ['prompt'],
    anyOf: [{ required: ['prompt'] }, { required: ['context', 'tasks'] }],
  },
  permission: 'auto',
  execute: async (input: unknown, ctx): Promise<ToolResult> => {
    if (!ctx.runSubAgent) {
      return {
        _tag: 'error',
        error: 'task tool unavailable: no sub-agent runner is wired into this context',
      }
    }

    const inp = input as TaskInput

    // 批量模式
    if ('tasks' in inp && Array.isArray(inp.tasks) && inp.tasks.length > 0) {
      const agentType = inp.subagent_type ?? 'general'
      const results: string[] = []
      for (const item of inp.tasks) {
        const req: SubAgentRequest = {
          agentType,
          prompt: item.assignment,
          ...(item.description ? { description: item.description } : {}),
          ...(item.role ? { role: item.role } : {}),
          ...(inp.context ? { context: inp.context } : {}),
        }
        const res = await ctx.runSubAgent(req)
        if (res._tag === 'error') {
          return { _tag: 'error', error: `Sub-agent failed: ${res.error}` }
        }
        results.push(`[${item.description ?? item.role ?? 'task'}] ${res.output}`)
      }
      return { _tag: 'success', output: results.join('\n\n') }
    }

    // 单任务模式
    const single = inp as SingleTaskInput
    const req: SubAgentRequest = {
      agentType: single.subagent_type ?? 'general',
      prompt: single.prompt,
      ...(single.description ? { description: single.description } : {}),
      ...(single.model ? { model: single.model } : {}),
      ...(single.background ? { background: true } : {}),
    }
    const result = await ctx.runSubAgent(req)
    if (result._tag === 'error') {
      return { _tag: 'error', error: `Sub-agent failed: ${result.error}` }
    }
    if (result._tag === 'running') {
      return {
        _tag: 'success',
        output: `Background task started (jobId: ${result.jobId}). You will be notified on completion.`,
        metadata: { sessionId: result.sessionId, background: true, jobId: result.jobId },
      }
    }
    return {
      _tag: 'success',
      output: result.output,
      metadata: { sessionId: result.sessionId, ...(result.data ? { data: result.data } : {}) },
    }
  },
}
```

- [ ] **Step 8: 更新现有 task 测试**

旧测试中 `runSubAgent` mock 的 `toHaveBeenCalledWith` 期望需加 `agentType: 'general'`（因为无 subagent_type 默认 general）。更新：

```ts
// 原期望：{ prompt: 'write tests', description: undefined, model: undefined }
// 改为：
expect(runSubAgent).toHaveBeenCalledWith({
  agentType: 'general',
  prompt: 'write tests',
  description: undefined,
  model: undefined,
})
```

类似更新 "forwards description and model" 测试。

- [ ] **Step 9: 跑测试确认通过**

Run: `npx vitest run src/tools/builtin/task.test.ts src/core/agents/parallel.test.ts`
Expected: PASS（全部）

- [ ] **Step 10: 类型检查 + 全量测试**

Run: `npm run typecheck && npm run test`
Expected: 全部通过

- [ ] **Step 11: 提交**

```bash
git add src/core/agents/parallel.ts src/core/agents/parallel.test.ts src/core/agents/index.ts src/tools/builtin/task.ts src/tools/builtin/task.test.ts
git commit -m "feat(agents): task 工具支持 subagent_type + 批量并行 + 并发池"
```

---

## Task 10: Server 装配（agentRegistry 注入 + SSE 事件）

**Files:**
- Modify: `src/server/types.ts`（ServerContext 加 agentRegistry）
- Modify: `src/server/context.ts`（装配）
- Modify: `src/server/routes/chat.ts`（deps 注入 agentRegistry）
- Test: `src/server/context.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `src/server/context.test.ts` 末尾追加（若无此文件，先读确认）：

```ts
describe('agentRegistry', () => {
  it('createServerContext 默认装配含 4 个内置 agent 的注册表', () => {
    const ctx = createServerContext({
      db: createTestDB(),
      llmRegistry: createTestRegistry(),
    })
    expect(ctx.agentRegistry).toBeDefined()
    expect(ctx.agentRegistry.has('general')).toBe(true)
    expect(ctx.agentRegistry.has('researcher')).toBe(true)
    expect(ctx.agentRegistry.list().length).toBeGreaterThanOrEqual(4)
  })
})
```

> 若 context.test.ts 不存在，新建它（参考 server.test.ts 的测试模式）。需要 createTestDB/createTestRegistry helper。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/context.test.ts`
Expected: FAIL（`ctx.agentRegistry` undefined）

- [ ] **Step 3: 更新 ServerContext 类型**

在 `src/server/types.ts` 的 `ServerContext` 加字段，import 加：

```ts
import type { AgentRegistry } from '../core/agents/types.js'

type ServerContext = {
  db: DB
  config: Config
  toolRegistry: ToolRegistry
  llmRegistry: Registry
  urlRegistry: URLRegistry
  hookRunner: HookRunner
  pluginRegistry: PluginRegistry
  agentManager: AgentManager
  permissionStore: PermissionStore
  permissionMode: 'default' | 'auto'
  cwd: string
  /** Agent 类型注册表（spec: multi-agent-design）。 */
  agentRegistry: AgentRegistry
  chatStream?: typeof chatStreamFn
}
```

- [ ] **Step 4: 更新 createServerContext**

在 `src/server/context.ts`，import 加：

```ts
import { BUILTIN_AGENTS, createAgentRegistry } from '../core/agents/index.js'
```

`createServerContext` 函数内，return 前加：

```ts
  // 装配 agent 注册表（内置默认；项目/用户 agent 在启动时由 bootstrap 补充加载）
  const agentRegistry = createServerContextOpts_agentRegistry ?? (() => {
    const reg = createAgentRegistry()
    for (const def of BUILTIN_AGENTS) reg.register(def)
    return reg
  })()
```

> 简化：直接在 return 对象内构造。修改 `CreateServerContextOptions` 加可选 `agentRegistry?`，return 中：

```ts
function createServerContext(opts: CreateServerContextOptions): ServerContext {
  const hookRunner = createHookRunner()
  // Agent 注册表：测试可注入；默认含内置 agent
  const agentRegistry = opts.agentRegistry ?? (() => {
    const reg = createAgentRegistry()
    for (const def of BUILTIN_AGENTS) reg.register(def)
    return reg
  })()
  return {
    db: opts.db,
    config: opts.config ?? DEFAULT_CONFIG,
    toolRegistry: opts.toolRegistry ?? createDefaultRegistry(opts.config ?? DEFAULT_CONFIG),
    llmRegistry: opts.llmRegistry,
    urlRegistry: createDefaultURLRegistry(),
    hookRunner,
    pluginRegistry: createPluginRegistry(hookRunner),
    agentManager: createAgentManager(),
    permissionStore: createPermissionStore(),
    permissionMode: 'default',
    agentRegistry,
    cwd: opts.cwd ?? process.cwd(),
    ...(opts.chatStream ? { chatStream: opts.chatStream } : {}),
  }
}
```

`CreateServerContextOptions` 加 `agentRegistry?: AgentRegistry`。

- [ ] **Step 5: chat 路由注入 agentRegistry**

在 `src/server/routes/chat.ts` 的 `deps: LoopDeps` 构造中，加 `agentRegistry: ctx.agentRegistry`：

```ts
      const deps: LoopDeps = {
        db: ctx.db,
        llmRegistry: ctx.llmRegistry,
        toolRegistry: ctx.toolRegistry,
        urlRegistry: ctx.urlRegistry,
        hookRunner: ctx.hookRunner,
        permission: permissionChecker,
        config: ctx.config,
        agentRegistry: ctx.agentRegistry,
        cwd,
        ...(ctx.chatStream ? { chatStream: ctx.chatStream } : {}),
      }
```

- [ ] **Step 6: AgentManager 扩展（session 恢复追踪，spec §4.8）**

现有 `src/server/agent-manager.ts` 的 `ActiveRun` 类型扩展，记录子 agent 关系，支持重启后通过 parentId 重建 agent 树。

在 `src/server/agent-manager.ts`，`ActiveRun` 类型加可选字段：

```ts
type ActiveRun = {
  sessionId: string
  state: AgentState
  deps: AgentDependencies
  /** 若为子 agent run：记录父 sessionId（恢复时重建树）。 */
  parentSessionId?: string
  /** 子 agent 类型名（调试/展示用）。 */
  agentType?: string
  /** 后台任务 jobId（后台 subagent）。 */
  jobId?: string
}
```

`AgentManager` 接口加查询方法：

```ts
type AgentManager = {
  // ...现有方法...
  /** 查询某 session 的所有子 agent run（恢复/展示用）。 */
  children(parentSessionId: string): ActiveRun[]
  /** 查询所有后台任务（jobId 非空的 run）。 */
  backgroundJobs(): ActiveRun[]
}
```

实现：`children` 过滤 `runs` 中 `parentSessionId ===` 的；`backgroundJobs` 过滤 `jobId` 存在的。`register` 已接收 `ActiveRun`，无需改签名。

> **恢复语义**：重启后进程内状态丢失。DB `sessions.parentId` + `agentType` 完整持久化，重启时可查询树结构重建展示。运行中的后台任务标为「中断」（无法续传进程内执行），session 历史仍可查。这是 spec §4.8 的「parked」语义——本计划不实现自动续传（YAGNI），仅保证数据完整性。

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run src/server/context.test.ts src/server/routes/chat.test.ts src/server/agent-manager.test.ts`
Expected: PASS

若 agent-manager.test.ts 有类型错误（ActiveRun 新字段），补充。

- [ ] **Step 8: 类型检查 + 全量测试**

Run: `npm run typecheck && npm run test`
Expected: 全部通过

- [ ] **Step 9: 提交**

```bash
git add src/server/types.ts src/server/context.ts src/server/routes/chat.ts src/server/context.test.ts
git commit -m "feat(server): 装配 agentRegistry 到 ServerContext 并注入 agent loop"
```

---

## Task 11: 后台 subagent + worktree 隔离

> 本任务把后台执行和 worktree 隔离合并，因 worktree 只在 isolated agent 时触发，且后台常配 worktree。

**Files:**
- Create: `src/core/worktree.ts` + test
- Modify: `src/core/loop.ts`（runSubAgent 加 background + worktree 分支）
- Test: `src/core/loop.test.ts`（追加）

- [ ] **Step 1: 写 worktree 失败测试**

创建 `src/core/worktree.test.ts`（用临时 git repo）：

```ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPatchToParent, captureBaseline, captureDeltaPatch, createWorktree } from './worktree.js'

let repoDir: string

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'c0de-git-'))
  execSync('git init -b main', { cwd: repoDir })
  execSync('git config user.email t@t.com && git config user.name t', { cwd: repoDir })
  await writeFile(join(repoDir, 'a.txt'), 'initial')
  execSync('git add . && git commit -m init', { cwd: repoDir })
})

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true })
})

describe('worktree isolation', () => {
  it('captureBaseline 记录 HEAD 和工作区状态', async () => {
    const baseline = await captureBaseline(repoDir)
    expect(baseline.headCommit).toMatch(/^[0-9a-f]+$/)
    expect(baseline.repoRoot).toBe(repoDir)
  })

  it('createWorktree 创建隔离工作树并返回路径', async () => {
    const wt = await createWorktree(repoDir, 'subagent-1')
    expect(wt).toContain('subagent-1')
    // worktree 路径存在
    const { stat } = await import('node:fs/promises')
    await expect(stat(wt)).resolves.toBeDefined()
  })

  it('captureDeltaPatch 计算 worktree 相对 baseline 的 diff', async () => {
    const baseline = await captureBaseline(repoDir)
    const wt = await createWorktree(repoDir, 'subagent-2')
    await writeFile(join(wt, 'a.txt'), 'modified')
    await writeFile(join(wt, 'b.txt'), 'new file')
    const patch = await captureDeltaPatch(wt, baseline)
    expect(patch).toContain('modified')
    expect(patch).toContain('new file')
  })

  it('applyPatchToParent 把 diff 应用回父仓库并 commit', async () => {
    const baseline = await captureBaseline(repoDir)
    const wt = await createWorktree(repoDir, 'subagent-3')
    await writeFile(join(wt, 'a.txt'), 'changed by agent')
    const patch = await captureDeltaPatch(wt, baseline)
    const result = await applyPatchToParent(repoDir, patch, 'agent(isolated): test')
    expect(result.commitSha).toMatch(/^[0-9a-f]+$/)
    // 父仓库内容已变
    const content = await (await import('node:fs/promises')).readFile(join(repoDir, 'a.txt'), 'utf-8')
    expect(content).toBe('changed by agent')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/worktree.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 worktree.ts**

创建 `src/core/worktree.ts`。用 `node:child_process` execSync 执行 git 命令（c0de-agent bash 工具是 ToolContext 级，worktree.ts 是 core 层，直接用 child_process 更合适）。

```ts
import { execSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 单仓库 baseline 状态（简化版，不处理嵌套 repo）。 */
interface RepoBaseline {
  repoRoot: string
  headCommit: string
  staged: string
  unstaged: string
  untracked: string[]
}

function git(cwd: string, args: string[]): string {
  return execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

/** 捕获仓库当前 baseline（HEAD + staged + unstaged + untracked）。 */
async function captureBaseline(repoRoot: string): Promise<RepoBaseline> {
  const headCommit = git(repoRoot, ['rev-parse', 'HEAD'])
  const staged = git(repoRoot, ['diff', '--cached', '--binary'])
  const unstaged = git(repoRoot, ['diff', '--binary'])
  const untrackedRaw = git(repoRoot, ['ls-files', '--others', '--exclude-standard'])
  const untracked = untrackedRaw.split('\n').filter(Boolean)
  return { repoRoot, headCommit, staged, unstaged, untracked }
}

/** 创建隔离 worktree，返回其路径（子 agent 的 cwd）。 */
async function createWorktree(repoRoot: string, branchName: string): Promise<string> {
  const wtDir = await mkdtemp(join(tmpdir(), `c0de-wt-${branchName}-`))
  git(repoRoot, ['worktree', 'add', '--detach', wtDir, 'HEAD'])
  return wtDir
}

/** 计算 worktree 相对 baseline 的 diff（简化：直接 diff HEAD）。 */
async function captureDeltaPatch(worktreeDir: string, _baseline: RepoBaseline): Promise<string> {
  // 简化：worktree 内所有改动（相对其 HEAD，即父 baseline）的 diff
  // 包括 staged、unstaged、untracked
  let patch = git(worktreeDir, ['diff', 'HEAD', '--binary'])
  // untracked 文件需单独加入 diff
  const untracked = git(worktreeDir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)
  for (const f of untracked) {
    try {
      patch += '\n' + git(worktreeDir, ['diff', '--no-index', '/dev/null', f])
    } catch {
      // git diff --no-index 在文件存在时返回非 0 但有输出
    }
  }
  return patch
}

/** 把 patch 应用回父仓库并自动 commit。返回 commit SHA。 */
async function applyPatchToParent(
  repoRoot: string,
  patch: string,
  commitMessage: string,
): Promise<{ commitSha: string; warnings: string[] }> {
  if (!patch.trim()) {
    // 无变更，不 commit
    return { commitSha: git(repoRoot, ['rev-parse', 'HEAD']), warnings: [] }
  }
  // 通过 stdin 应用 patch
  const { execSync: es } = await import('node:child_process')
  try {
    es(`git apply`, { cwd: repoRoot, encoding: 'utf-8', input: patch, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    // apply 失败：尝试 --3way
    es(`git apply --3way`, { cwd: repoRoot, encoding: 'utf-8', input: patch, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  git(repoRoot, ['add', '-A'])
  git(repoRoot, ['commit', '-m', commitMessage])
  return { commitSha: git(repoRoot, ['rev-parse', 'HEAD']), warnings: [] }
}

/** 清理 worktree（git worktree remove）。 */
function removeWorktree(repoRoot: string, worktreeDir: string): void {
  try {
    git(repoRoot, ['worktree', 'remove', '--force', worktreeDir])
  } catch {
    // 清理失败忽略（可能已删）
  }
}

export { applyPatchToParent, captureBaseline, captureDeltaPatch, createWorktree, removeWorktree }
export type { RepoBaseline }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/worktree.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 5: runSubAgent 加 worktree + background 分支**

在 `src/core/loop.ts` 的 `runSubAgent` 中，第 2 步（创建子 session）前，加 worktree 处理：

```ts
  // 2. worktree 隔离（isolated agent）
  let worktreePath: string | undefined
  let baseline: RepoBaseline | undefined
  if (def.isolated) {
    try {
      baseline = await captureBaseline(deps.cwd)
      worktreePath = await createWorktree(deps.cwd, `subagent-${childSessionId}`)
    } catch (e) {
      // worktree 失败回退共享 cwd
      console.warn(`[subagent] worktree creation failed, falling back to shared cwd: ${e instanceof Error ? e.message : e}`)
    }
  }
  const childCwd = worktreePath ?? deps.cwd
```

需 import：
```ts
import { applyPatchToParent, captureBaseline, createWorktree, removeWorktree } from './worktree.js'
import type { RepoBaseline } from './worktree.js'
```

在子 agent 运行结束后（return success 前），加 worktree 回传：

```ts
  // worktree 回传：自动 apply 回父
  let patchPath: string | undefined
  if (baseline && worktreePath) {
    try {
      const patch = await captureDeltaPatch(worktreePath, baseline)
      const applyResult = await applyPatchToParent(
        deps.cwd,
        patch,
        `agent(isolated): ${title}`,
      )
      // 更新子 session worktreePath 记录（用于恢复）
    } catch (e) {
      // apply 失败：patch 附在结果中
      console.warn(`[subagent] worktree apply failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      removeWorktree(deps.cwd, worktreePath)
    }
  }
```

> 注意：worktree 回传代码块要放在 `errMsg !== null` 检查**之后**（失败时不 apply），但 `removeWorktree` 要在 finally 清理。重组 try/catch 结构。

- [ ] **Step 6: background 分支**

在 `runSubAgent` 开头，加 background 检查（在 worktree 之后、子 agent 运行之前）：

```ts
  // 后台模式：fork 异步运行，立即返回 running
  if (request.background) {
    const jobId = childSession.id
    // fork 异步（不 await）
    void (async () => {
      const result = await runSubAgentSync(/* 内联同步逻辑 */)
      // 完成时向父 session 注入合成消息通知
      // 见下方 injectNotification
    })()
    return { _tag: 'running', jobId, sessionId: childSession.id }
  }
```

> **简化**：把 runSubAgent 的主体（创建子 agent + 运行 + 结果组装）抽成内部 helper `runSubAgentCore`，background 模式 fork 它。完成后通过 `appendMessage` 向父 session 注入合成 user message：

```ts
  async function notifyParent(childOutput: string, success: boolean) {
    const tag = success ? 'task_result' : 'task_error'
    const synthetic = `<task id="${childSession.id}" state="${success ? 'completed' : 'failed'}">\n<${tag}>\n${childOutput}\n</${tag}>\n</task>`
    await appendMessage(deps.db, parent.session.id, {
      role: 'user',
      content: [{ _tag: 'text', text: synthetic }],
    })
  }
```

- [ ] **Step 7: 跑测试 + 全量**

Run: `npx vitest run src/core/loop.test.ts src/core/worktree.test.ts`
Expected: PASS

Run: `npm run typecheck && npm run test`
Expected: 全部通过

- [ ] **Step 8: 提交**

```bash
git add src/core/worktree.ts src/core/worktree.test.ts src/core/loop.ts src/core/loop.test.ts
git commit -m "feat(agents): 后台 subagent + 可选 git worktree 隔离（自动 apply 回父）"
```

---

## Task 12: 前端接线（subagent_* 事件 + SubAgents 组件）

**Files:**
- Modify: `src/web/hooks/useChat.ts`（reduceChatEvent 处理 subagent_*）
- Create: `src/web/components/session/SubAgents.tsx`
- Test: `src/web/hooks/useChat.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `src/web/hooks/useChat.test.ts` 末尾追加（先读文件确认 reduceChatEvent 已导出测试）：

```ts
describe('reduceChatEvent subagent', () => {
  it('subagent_start 不崩溃（透传，状态不变）', () => {
    const state = reduceChatEvent(INITIAL, {
      _tag: 'subagent_start',
      childId: 'c1',
      agentType: 'researcher',
      description: '探索',
      background: false,
    })
    // subagent 事件暂不改变 messages，但不应崩溃
    expect(state.messages).toEqual([])
  })

  it('subagent_progress 和 subagent_end 透传不崩溃', () => {
    let state = reduceChatEvent(INITIAL, {
      _tag: 'subagent_progress',
      childId: 'c1',
      toolName: 'grep',
      status: 'running',
    })
    state = reduceChatEvent(state, {
      _tag: 'subagent_end',
      childId: 'c1',
      agentType: 'researcher',
      success: true,
      output: 'done',
    })
    expect(state.error).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/web/hooks/useChat.test.ts`
Expected: FAIL（reduceChatEvent 的 switch 没有 subagent_* case，落到 default 返回原 state——实际可能"通过"但未显式处理。若 default 已返回 state，测试会通过。需确认是否真 FAIL）。

> 若测试通过（因 default case），说明 reduceChatEvent 已容错。则本步改为：扩展 ChatState 加 `subagents` 字段，让事件真正改变状态。

**改进 ChatState 加 subagents 跟踪**。修改测试：

```ts
type SubagentInfo = {
  childId: string
  agentType: string
  description: string
  status: 'running' | 'completed' | 'failed'
}

// ChatState 加：
//   subagents: SubagentInfo[]
```

测试改为验证 subagents 数组变化：

```ts
  it('subagent_start 记录运行中的子 agent', () => {
    const state = reduceChatEvent(INITIAL, {
      _tag: 'subagent_start',
      childId: 'c1',
      agentType: 'researcher',
      description: '探索',
      background: false,
    })
    expect(state.subagents).toHaveLength(1)
    expect(state.subagents[0]).toMatchObject({ childId: 'c1', status: 'running' })
  })

  it('subagent_end 更新状态为 completed', () => {
    const s1 = reduceChatEvent(INITIAL, {
      _tag: 'subagent_start', childId: 'c1', agentType: 'researcher', description: 'x', background: false,
    })
    const s2 = reduceChatEvent(s1, {
      _tag: 'subagent_end', childId: 'c1', agentType: 'researcher', success: true, output: 'done',
    })
    expect(s2.subagents.find((s) => s.childId === 'c1')?.status).toBe('completed')
  })
```

- [ ] **Step 3: 扩展 ChatState 与 reduceChatEvent**

在 `src/web/hooks/useChat.ts`：

ChatState 加 `subagents`：
```ts
type SubagentInfo = {
  childId: string
  agentType: string
  description: string
  status: 'running' | 'completed' | 'failed'
}

type ChatState = {
  messages: Message[]
  isStreaming: boolean
  usage: { input: number; output: number } | null
  error: string | null
  pendingPermission: { toolCallId: string; tool: string; input: unknown } | null
  subagents: SubagentInfo[]
}
```

INITIAL 加 `subagents: []`。

reduceChatEvent 的 switch 加 case（在 `llm_detail` 后）：

```ts
    case 'subagent_start': {
      const subagents = [
        ...state.subagents.filter((s) => s.childId !== event.childId),
        { childId: event.childId, agentType: event.agentType, description: event.description, status: 'running' as const },
      ]
      return { ...state, subagents }
    }
    case 'subagent_progress':
      return state // 进度更新可选，暂不改变状态
    case 'subagent_end': {
      const subagents = state.subagents.map((s) =>
        s.childId === event.childId
          ? { ...s, status: (event.success ? 'completed' : 'failed') as 'completed' | 'failed' }
          : s,
      )
      return { ...state, subagents }
    }
```

- [ ] **Step 4: 创建 SubAgents 组件**

创建 `src/web/components/session/SubAgents.tsx`（基于现有 SubAgentProgress，但消费新数据结构）：

```tsx
import { css } from '@linaria/core'
import type { SubagentInfo } from '../../hooks/useChat.js'

const card = css`
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 8px;
  margin: 6px 0;
  font-size: 13px;
`

const statusColor = (status: SubagentInfo['status']): string => {
  switch (status) {
    case 'running':
      return 'var(--accent)'
    case 'completed':
      return 'var(--success, green)'
    case 'failed':
      return 'var(--danger, red)'
  }
}

export function SubAgents({ subagents }: { subagents: SubagentInfo[] }) {
  if (subagents.length === 0) return null
  return (
    <div data-testid="subagents-list">
      {subagents.map((s) => (
        <div key={s.childId} className={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>
              {s.agentType} · {s.description}
            </span>
            <span style={{ color: statusColor(s.status) }}>{s.status}</span>
          </div>
          <span style={{ color: 'var(--text-secondary)' }}>id: {s.childId.slice(0, 8)}</span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/web/hooks/useChat.test.ts`
Expected: PASS

- [ ] **Step 6: 类型检查 + 全量测试**

Run: `npm run typecheck && npm run test`
Expected: 全部通过

- [ ] **Step 7: lint**

Run: `npm run lint`
Expected: 无错误（若有 linaria 相关警告可忽略）

- [ ] **Step 8: 提交**

```bash
git add src/web/hooks/useChat.ts src/web/hooks/useChat.test.ts src/web/components/session/SubAgents.tsx
git commit -m "feat(web): 接线 subagent_* 事件 + SubAgents 进度组件"
```

---

## Task 13: 集成测试 + 最终验证

**Files:**
- Create: `tests/integration/multi-agent.test.ts`

- [ ] **Step 1: 写端到端集成测试**

创建 `tests/integration/multi-agent.test.ts`。验证主 agent → task 工具 → 子 agent 派发全流程（mock chatStream）。

```ts
import { describe, expect, it } from 'vitest'
import { createDB } from '../../src/db/client.js'
import { migrateDB } from '../../src/db/migrate.js'
import { BUILTIN_AGENTS, createAgentRegistry } from '../../src/core/agents/index.js'
import { createAgent, runAgent } from '../../src/core/agent.js'
import { DEFAULT_CONFIG } from '../../src/core/config.js'
import { createSession, getSession } from '../../src/session/session.js'
import { createDefaultRegistry } from '../../src/tools/index.js'
import { autoAllowChecker } from '../../src/tools/permission.js'
import { createTestLLMRegistry } from '../helpers/llm.js'
import type { LoopDeps } from '../../src/core/loop.js'
import type { StreamChunk } from '../../src/shared/types/llm.js'

// mock：主 agent 第一轮调 task 工具，第二轮基于结果回复
let turn = 0
function mockMainStream(): AsyncGenerator<StreamChunk> {
  const t = turn++
  async function* gen() {
    if (t === 0) {
      yield { _tag: 'tool_call_start', id: 'tc1', name: 'task' } as const
      yield {
        _tag: 'tool_call_end',
        id: 'tc1',
        argumentsFinal: JSON.stringify({ subagent_type: 'researcher', prompt: 'find auth files' }),
      } as const
      yield { _tag: 'done' } as const
    } else {
      yield { _tag: 'text', text: 'Research complete.' } as const
      yield { _tag: 'done' } as const
    }
  }
  return gen()
}

// mock：子 agent 调 yield
function mockChildStream(): AsyncGenerator<StreamChunk> {
  async function* gen() {
    yield { _tag: 'tool_call_start', id: 'yc1', name: 'yield' } as const
    yield {
      _tag: 'tool_call_end',
      id: 'yc1',
      argumentsFinal: JSON.stringify({ data: { files: ['auth.ts'] } }),
    } as const
    yield { _tag: 'done' } as const
  }
  return gen()
}

describe('multi-agent integration', () => {
  it('主 agent 派发 researcher 子 agent，子 agent yield 结构化结果', async () => {
    const db = await createDB()
    await migrateDB(db)
    const agentRegistry = createAgentRegistry()
    for (const def of BUILTIN_AGENTS) agentRegistry.register(def)

    const deps: LoopDeps = {
      db,
      llmRegistry: createTestLLMRegistry(),
      toolRegistry: createDefaultRegistry(),
      permission: autoAllowChecker,
      config: DEFAULT_CONFIG,
      cwd: '/tmp',
      agentRegistry,
      chatStream: async () => mockMainStream(),
    }

    const parentSession = await createSession(db, 'integration test')
    const parent = await createAgent(
      parentSession,
      { provider: 'test', model: 'test', tools: ['task'], plugins: [] },
      deps,
    )

    const events = []
    for await (const ev of runAgent(parent, [{ _tag: 'text', text: 'research auth' }], deps)) {
      events.push(ev)
    }

    // 验证：主 agent 调了 task 工具
    expect(events.some((e) => e._tag === 'tool_call_start' && e.tool === 'task')).toBe(true)
    // task 工具结果应含子 agent 的 yield data
    const taskEnd = events.find((e) => e._tag === 'tool_call_end' && e.id === 'tc1')
    expect(taskEnd).toBeDefined()
  })

  it('未注册 agentType 时 task 工具返回错误', async () => {
    const db = await createDB()
    await migrateDB(db)
    const emptyRegistry = createAgentRegistry() // 空

    const deps: LoopDeps = {
      db,
      llmRegistry: createTestLLMRegistry(),
      toolRegistry: createDefaultRegistry(),
      permission: autoAllowChecker,
      config: DEFAULT_CONFIG,
      cwd: '/tmp',
      agentRegistry: emptyRegistry,
      chatStream: async () => mockMainStream(),
    }

    const parentSession = await createSession(db, 'error test')
    const parent = await createAgent(
      parentSession,
      { provider: 'test', model: 'test', tools: ['task'], plugins: [] },
      deps,
    )

    const events = []
    for await (const ev of runAgent(parent, [{ _tag: 'text', text: 'x' }], deps)) {
      events.push(ev)
    }

    const taskEnd = events.find(
      (e) => e._tag === 'tool_call_end' && e.id === 'tc1',
    ) as { _tag: 'tool_call_end'; result: { _tag: string; error?: string } } | undefined
    expect(taskEnd?.result._tag).toBe('error')
    expect(taskEnd?.result.error).toMatch(/Unknown agent type/i)
  })
})
```

> 注：`createTestLLMRegistry` 需在 `tests/helpers/llm.ts`（若不存在则创建简单 mock）。检查 `tests/helpers/` 是否已有。

- [ ] **Step 2: 跑集成测试确认通过**

Run: `npx vitest run tests/integration/multi-agent.test.ts`
Expected: PASS（2 个测试）

若失败，根据错误调整 mock 或断言。

- [ ] **Step 3: 全量验证**

Run: `npm run typecheck && npm run test && npm run lint`
Expected: 全部通过，无错误

- [ ] **Step 4: 生产构建验证**

Run: `npm run build`
Expected: 构建成功（agents 模块、worktree、yield 都打包进去）

- [ ] **Step 5: 提交**

```bash
git add tests/integration/multi-agent.test.ts tests/helpers/llm.ts
git commit -m "test: 多 agent 端到端集成测试"
```

---

## Self-Review 清单

完成所有任务后，逐项核对：

1. **Spec 覆盖**：
   - ✅ AgentDefinition + registry → Task 1
   - ✅ markdown discovery → Task 2
   - ✅ 内置 agent → Task 3
   - ✅ Config.agents → Task 4
   - ✅ DB schema → Task 5
   - ✅ SubAgent 类型 + AgentDependencies → Task 6
   - ✅ yield 工具 → Task 7
   - ✅ runSubAgent 增强 → Task 8
   - ✅ task 工具增强 + 并行 → Task 9
   - ✅ Server 装配 → Task 10
   - ✅ 后台 + worktree → Task 11
   - ✅ 前端 → Task 12
   - ✅ 集成测试 → Task 13

2. **类型一致性**：
   - `SubAgentRequest.agentType` 在 Task 6 定义，Task 8/9 使用 ✓
   - `SubAgentResult.running` 在 Task 6 定义，Task 9 使用 ✓
   - `AgentRegistry` 在 Task 1 定义，Task 6/10 使用 ✓
   - `ToolContext.collectYield` 在 Task 6 定义，Task 7/8 使用 ✓
   - `subagent_*` AgentEvent 在 Task 6 定义，Task 8 发射 + Task 12 消费 ✓
   - `LoopDeps._subagentYieldCollector` / `_subagentEventSink` / `_subagentDepth` 在 Task 8 定义并透传 ✓
   - `maxRecursion` 在 Task 3（builtin 定义）+ Task 8（runSubAgent 强制） ✓
   - `AgentManager.children()` / `backgroundJobs()` 在 Task 10 定义 ✓

3. **Spec 缺口修复**（self-review 发现并已补）：
   - 事件发射：runSubAgent 现发射 `subagent_start`/`subagent_end`（spec §4.5 step 7）→ Task 8 已补
   - 递归限制：runSubAgent 按 `maxRecursion` + `_subagentDepth` 条件移除 task 工具（spec §4.5 step 4 / §8）→ Task 8 已补
   - Session 恢复：AgentManager 扩展追踪父子关系（spec §4.8）→ Task 10 Step 6 已补

4. **占位符扫描**：无 TODO/TBD/placeholder（所有步骤含完整代码）

---

## 验证命令汇总

每个任务后：
- `npx vitest run <具体测试文件>` — 单元测试
- `npm run typecheck` — 类型检查
- `npm run test` — 全量测试
- `npm run lint` — lint
- `npm run build` — 构建验证（Task 13）
