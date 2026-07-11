# Dynamic Workflow 系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 c0de-agent 增加完整的 Dynamic Workflow 能力——JS 编排脚本、工作流注册表、`/workflow` 命令、后台并行执行、结构化报告、3 个内置模板、`workflowz` 关键词增强、前端可视化。

**Architecture:** 新建 `src/core/workflows/` 模块，包含类型定义、注册表、发现、执行上下文、执行引擎、内置模板。通过 `/workflow` slash 命令和 REST API 暴露。工作流脚本通过 `dynamic import` 执行，拥有完整 Node 访问权限（完全信任模型）。`runSubagent`/`runSubagents` 委托给现有 `runSubAgent()`（`src/core/loop.ts:122`）。

**Tech Stack:** TypeScript, Hono (server), React + Linaria (web), Vitest (testing), pnpm

**设计文档:** `docs/superpowers/specs/2026-07-11-dynamic-workflow-design.md`

---

## File Structure

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/core/workflows/types.ts` | 所有工作流类型定义 |
| `src/core/workflows/registry.ts` | WorkflowRegistry 内存注册表 |
| `src/core/workflows/discovery.ts` | 从目录扫描 `.js` 工作流文件 |
| `src/core/workflows/builtins.ts` | 3 个内置工作流（security-audit/code-review/migration-check） |
| `src/core/workflows/context.ts` | buildWorkflowContext — 注入 runSubagent/utils/progress |
| `src/core/workflows/runtime.ts` | executeWorkflow — 加载+构建ctx+执行 |
| `src/core/workflows/index.ts` | barrel export |
| `src/server/routes/workflows.ts` | REST API (list/get/run/save/delete) |
| `src/web/components/session/WorkflowRunner.tsx` | 工作流进度面板 |
| 测试文件 ×8 | 见各 Task |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/core/types.ts` | CommandContext 新增 `workflowRegistry?` |
| `src/core/slash.ts` | 新增 `workflowCommand` + 注册到 builtinCommands |
| `src/core/workflow.ts` | `WORKFLOW_NOTICE` → `buildWorkflowNotice(workflows)` |
| `src/core/index.ts` | export workflows barrel |
| `src/server/types.ts` | ServerContext 新增 `workflowRegistry` |
| `src/server/context.ts` | 创建 workflowRegistry + 注入 |
| `src/server/app.ts` | 注册 `/api/workflows` 路由 |
| `src/server/routes/chat.ts` | 注入 workflowRegistry + 调用 buildWorkflowNotice |
| `src/web/components/session/WorkflowGraph.tsx` | 新增 `phases` + `currentPhase` props |
| `src/web/components/session/WorkflowGraph.test.tsx` | 追加 phase 测试 |

---

## Task 1: 工作流类型定义

**Files:**
- Create: `src/core/workflows/types.ts`
- Test: `src/core/workflows/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/workflows/types.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type {
  WorkflowAgentResult,
  WorkflowContext,
  WorkflowEntry,
  WorkflowMeta,
  WorkflowModule,
  WorkflowResult,
  WorkflowUtils,
} from './types.js'

describe('Workflow types', () => {
  it('WorkflowMeta accepts required fields', () => {
    const meta: WorkflowMeta = {
      name: 'security-audit',
      description: '安全审计',
      argsHint: '[target]',
      phases: ['scan', 'verify', 'report'],
    }
    expect(meta.name).toBe('security-audit')
  })

  it('WorkflowMeta works without optional fields', () => {
    const meta: WorkflowMeta = { name: 'simple', description: '简单' }
    expect(meta.name).toBe('simple')
    expect(meta.phases).toBeUndefined()
  })

  it('WorkflowResult accepts output and data', () => {
    const r: WorkflowResult = { output: 'done', data: { count: 3 } }
    expect(r.output).toBe('done')
  })

  it('WorkflowAgentResult discriminated union works', () => {
    const ok: WorkflowAgentResult = { ok: true, output: 'scanned', data: [] }
    const fail: WorkflowAgentResult = { ok: false, error: 'timeout' }
    expect(ok.ok).toBe(true)
    expect(fail.ok).toBe(false)
  })

  it('WorkflowEntry has execute and source', () => {
    const entry: WorkflowEntry = {
      meta: { name: 'test', description: 'test wf' },
      source: 'builtin',
      execute: async () => ({ output: 'ok' }),
    }
    expect(entry.source).toBe('builtin')
    expect(typeof entry.execute).toBe('function')
  })

  it('WorkflowContext shape is correct', () => {
    const ctx: WorkflowContext = {
      project: { rootDir: '/tmp', name: 'test' },
      args: '',
      runSubagent: async () => ({ ok: true, output: '' }),
      runSubagents: async () => [],
      progress: () => {},
      utils: {
        glob: async () => [],
        grep: async () => [],
        read: async () => '',
        splitByDirectory: async () => [],
      },
    }
    expect(ctx.project.rootDir).toBe('/tmp')
  })

  it('WorkflowUtils type compiles', () => {
    const utils: WorkflowUtils = {
      glob: async () => [],
      grep: async () => [],
      read: async () => '',
      splitByDirectory: async () => [],
    }
    expect(typeof utils.glob).toBe('function')
  })

  it('WorkflowModule type compiles', () => {
    const mod: WorkflowModule = {
      meta: { name: 'test', description: 'x' },
      default: async () => ({ output: 'done' }),
    }
    expect(mod.meta.name).toBe('test')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/workflows/types.test.ts`
Expected: FAIL — module `./types.js` not found

- [ ] **Step 3: Write minimal implementation**

Create `src/core/workflows/types.ts`:

```typescript
/** 工作流元数据（脚本导出的 meta 对象）。 */
interface WorkflowMeta {
  /** 唯一标识，同时也是 slash 命令名。 */
  name: string
  /** 显示用描述。 */
  description: string
  /** 参数提示（如 '[扫描目标描述]'）。 */
  argsHint?: string
  /** 执行阶段标签（用于进度展示）。 */
  phases?: string[]
  /** 超时（秒），超时终止。 */
  timeout?: number
}

/** 工作流执行结果。 */
type WorkflowResult = {
  /** 人类可读总结（显示给用户）。 */
  output?: string
  /** 结构化数据（存档/程序化消费）。 */
  data?: unknown
}

/** 子 agent 返回结果（区分成功/失败）。 */
type WorkflowAgentResult =
  | { ok: true; output: string; data?: unknown }
  | { ok: false; error: string }

/** 工作流内置工具集（受限文件系统操作）。 */
interface WorkflowUtils {
  glob: (pattern: string) => Promise<string[]>
  grep: (
    pattern: string,
    path?: string,
  ) => Promise<Array<{ path: string; line: number; text: string }>>
  read: (filePath: string, range?: { start: number; end: number }) => Promise<string>
  splitByDirectory: (
    rootDir: string,
    opts?: { depth?: number; ignore?: string[] },
  ) => Promise<Array<{ name: string; path: string; files: string[] }>>
}

/** 工作流上下文（注入给脚本 default 函数的参数）。 */
interface WorkflowContext {
  /** 项目信息。 */
  project: { rootDir: string; name: string; gitBranch?: string }
  /** 用户传入的参数字符串。 */
  args: string
  /** 派发单个子 agent。委托 runSubAgent。 */
  runSubagent: (
    type: string,
    params: { assignment: string; description?: string; model?: string },
  ) => Promise<WorkflowAgentResult>
  /** 批量并行派发子 agent。委托 runSubAgent，concurrency pool。 */
  runSubagents: (
    type: string,
    tasks: Array<{ assignment: string; description?: string; role?: string }>,
    context?: string,
  ) => Promise<WorkflowAgentResult[]>
  /** 进度上报（→ SSE → 前端）。 */
  progress: (message: string, detail?: unknown) => void
  /** 内置工具。 */
  utils: WorkflowUtils
}

/** 工作流脚本模块（dynamic import 后的形状）。 */
interface WorkflowModule {
  meta: WorkflowMeta
  default: (ctx: WorkflowContext) => Promise<WorkflowResult>
}

/** 注册表中的条目。 */
interface WorkflowEntry {
  meta: WorkflowMeta
  source: 'builtin' | 'user' | 'project'
  filePath?: string
  /** 执行器。 */
  execute: (ctx: WorkflowContext) => Promise<WorkflowResult>
  /** 源码文本（show 命令和编辑用）。 */
  sourceCode?: string
}

export type {
  WorkflowAgentResult,
  WorkflowContext,
  WorkflowEntry,
  WorkflowMeta,
  WorkflowModule,
  WorkflowResult,
  WorkflowUtils,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/workflows/types.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/workflows/types.ts src/core/workflows/types.test.ts
git commit -m "feat(workflow): add workflow type definitions"
```

---

## Task 2: 工作流注册表

**Files:**
- Create: `src/core/workflows/registry.ts`
- Test: `src/core/workflows/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/workflows/registry.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type { WorkflowEntry } from './types.js'
import { createWorkflowRegistry } from './registry.js'

function makeEntry(name: string, source: WorkflowEntry['source'] = 'builtin'): WorkflowEntry {
  return {
    meta: { name, description: `${name} workflow` },
    source,
    execute: async () => ({ output: `${name} ran` }),
  }
}

describe('WorkflowRegistry', () => {
  it('registers and retrieves by name', () => {
    const reg = createWorkflowRegistry()
    reg.register(makeEntry('security-audit'))
    expect(reg.has('security-audit')).toBe(true)
    expect(reg.get('security-audit')?.meta.name).toBe('security-audit')
  })

  it('returns undefined for unknown name', () => {
    const reg = createWorkflowRegistry()
    expect(reg.get('nonexistent')).toBeUndefined()
    expect(reg.has('nonexistent')).toBe(false)
  })

  it('later registration overwrites earlier same-name entry', () => {
    const reg = createWorkflowRegistry()
    reg.register(makeEntry('audit', 'builtin'))
    reg.register(makeEntry('audit', 'project'))
    const entry = reg.get('audit')
    expect(entry?.source).toBe('project')
  })

  it('lists all registered entries', () => {
    const reg = createWorkflowRegistry()
    reg.register(makeEntry('a'))
    reg.register(makeEntry('b'))
    reg.register(makeEntry('c'))
    expect(reg.list().length).toBe(3)
    expect(reg.list().map((e) => e.meta.name)).toContain('a')
    expect(reg.list().map((e) => e.meta.name)).toContain('c')
  })

  it('deletes entry and returns true', () => {
    const reg = createWorkflowRegistry()
    reg.register(makeEntry('temp'))
    expect(reg.delete('temp')).toBe(true)
    expect(reg.has('temp')).toBe(false)
  })

  it('returns false when deleting nonexistent entry', () => {
    const reg = createWorkflowRegistry()
    expect(reg.delete('ghost')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/workflows/registry.test.ts`
Expected: FAIL — module `./registry.js` not found

- [ ] **Step 3: Write minimal implementation**

Create `src/core/workflows/registry.ts`:

```typescript
import type { WorkflowEntry } from './types.js'

/** 工作流注册表：内存 Map<name, WorkflowEntry>，后注册覆盖同名。 */
function createWorkflowRegistry() {
  const entries = new Map<string, WorkflowEntry>()

  return {
    register(entry: WorkflowEntry) {
      entries.set(entry.meta.name, entry)
    },
    get(name: string): WorkflowEntry | undefined {
      return entries.get(name)
    },
    list(): WorkflowEntry[] {
      return Array.from(entries.values())
    },
    has(name: string): boolean {
      return entries.has(name)
    },
    delete(name: string): boolean {
      return entries.delete(name)
    },
  }
}

type WorkflowRegistry = ReturnType<typeof createWorkflowRegistry>

export type { WorkflowRegistry }
export { createWorkflowRegistry }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/workflows/registry.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/workflows/registry.ts src/core/workflows/registry.test.ts
git commit -m "feat(workflow): add workflow registry"
```

---

## Task 3: 工作流发现

**Files:**
- Create: `src/core/workflows/discovery.ts`
- Test: `src/core/workflows/discovery.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/workflows/discovery.test.ts`:

```typescript
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverWorkflows } from './discovery.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'wf-disc-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeWorkflow(dir: string, name: string, source: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${name}.js`), source, 'utf-8')
}

const VALID_WORKFLOW = `
export const meta = { name: 'test-wf', description: 'test workflow' }
export default async function workflow(ctx) {
  return { output: 'done' }
}
`

describe('discoverWorkflows', () => {
  it('loads valid .js workflow files from project .c0de/workflows/', async () => {
    await writeWorkflow(join(tmpDir, '.c0de/workflows'), 'test-wf', VALID_WORKFLOW)
    const entries = await discoverWorkflows(tmpDir)
    expect(entries.length).toBe(1)
    expect(entries[0]?.meta.name).toBe('test-wf')
    expect(entries[0]?.source).toBe('project')
    expect(entries[0]?.sourceCode).toContain('test workflow')
    expect(typeof entries[0]?.execute).toBe('function')
  })

  it('skips files that fail to import and continues loading others', async () => {
    await writeWorkflow(
      join(tmpDir, '.c0de/workflows'),
      'broken',
      'this is not valid JS export',
    )
    await writeWorkflow(join(tmpDir, '.c0de/workflows'), 'good', VALID_WORKFLOW)
    const entries = await discoverWorkflows(tmpDir)
    // broken 文件会跳过（不阻塞），good 正常加载
    const names = entries.map((e) => e.meta.name)
    expect(names).toContain('good')
    expect(names).not.toContain('broken')
  })

  it('returns empty array when no .c0de/workflows directory exists', async () => {
    const entries = await discoverWorkflows(tmpDir)
    expect(entries).toEqual([])
  })

  it('uses filename as fallback name when meta.name is missing', async () => {
    const noName = `
export const meta = { description: 'no name field' }
export default async function workflow(ctx) {
  return { output: 'ok' }
}
`
    await writeWorkflow(join(tmpDir, '.c0de/workflows'), 'fallback-name', noName)
    const entries = await discoverWorkflows(tmpDir)
    expect(entries[0]?.meta.name).toBe('fallback-name')
  })

  it('skips files without meta export', async () => {
    const noMeta = `
export default async function workflow(ctx) {
  return { output: 'ok' }
}
`
    await writeWorkflow(join(tmpDir, '.c0de/workflows'), 'no-meta', noMeta)
    const entries = await discoverWorkflows(tmpDir)
    expect(entries.length).toBe(0)
  })

  it('skips files without default export', async () => {
    const noDefault = `
export const meta = { name: 'no-default', description: 'x' }
`
    await writeWorkflow(join(tmpDir, '.c0de/workflows'), 'no-default', noDefault)
    const entries = await discoverWorkflows(tmpDir)
    expect(entries.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to fails**

Run: `npx vitest run src/core/workflows/discovery.test.ts`
Expected: FAIL — module `./discovery.js` not found

- [ ] **Step 3: Write minimal implementation**

Create `src/core/workflows/discovery.ts`:

```typescript
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkflowEntry, WorkflowMeta, WorkflowModule } from './types.js'

/** 工作流目录相对路径。 */
const WORKFLOWS_DIR = '.c0de/workflows'

/**
 * 扫描项目目录下的 `.c0de/workflows/*.js` 文件，dynamic import 后转为 WorkflowEntry。
 * import 失败的文件跳过（warn），不阻塞其他工作流加载。
 */
async function discoverWorkflows(projectDir: string): Promise<WorkflowEntry[]> {
  const dirPath = join(projectDir, WORKFLOWS_DIR)
  const entries: WorkflowEntry[] = []

  let files: string[]
  try {
    const dirents = await readdir(dirPath)
    files = dirents.filter((f) => f.endsWith('.js'))
  } catch {
    // 目录不存在或不可读 → 返回空
    return entries
  }

  for (const file of files) {
    const filePath = join(dirPath, file)
    try {
      const sourceCode = await readFile(filePath, 'utf-8')
      const fileUrl = pathToFileURL(filePath).href
      const mod = (await import(fileUrl)) as Partial<WorkflowModule>

      if (!mod.meta || typeof mod.default !== 'function') {
        console.warn(`[workflow] skipping ${file}: missing meta or default export`)
        continue
      }

      // meta.name 缺省时取文件名（去 .js）
      const meta: WorkflowMeta = {
        ...mod.meta,
        name: mod.meta.name ?? basename(file, '.js'),
      }

      entries.push({
        meta,
        source: 'project',
        filePath,
        sourceCode,
        execute: mod.default,
      })
    } catch (e) {
      console.warn(
        `[workflow] failed to load ${file}: ${e instanceof Error ? e.message : e}`,
      )
    }
  }

  return entries
}

export { discoverWorkflows }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/workflows/discovery.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/workflows/discovery.ts src/core/workflows/discovery.test.ts
git commit -m "feat(workflow): add workflow discovery from .c0de/workflows/"
```

---

## Task 4: 内置工作流模板

**Files:**
- Create: `src/core/workflows/builtins.ts`
- Test: `src/core/workflows/builtins.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/workflows/builtins.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { BUILTIN_WORKFLOWS } from './builtins.js'
import type { WorkflowContext, WorkflowResult } from './types.js'

/** Minimal mock ctx for testing builtin execution. */
function makeMockCtx(overrides?: Partial<WorkflowContext>): WorkflowContext {
  return {
    project: { rootDir: '/tmp', name: 'test' },
    args: '',
    runSubagent: async () => ({ ok: true, output: '{}' }),
    runSubagents: async () => [{ ok: true, output: '{}' }],
    progress: () => {},
    utils: {
      glob: async () => [],
      grep: async () => [],
      read: async () => '',
      splitByDirectory: async () => [{ name: 'mod1', path: '/tmp/mod1', files: [] }],
    },
    ...overrides,
  }
}

describe('BUILTIN_WORKFLOWS', () => {
  it('has exactly 3 builtin workflows', () => {
    expect(BUILTIN_WORKFLOWS.length).toBe(3)
  })

  it('all have correct source = builtin', () => {
    for (const wf of BUILTIN_WORKFLOWS) {
      expect(wf.source).toBe('builtin')
    }
  })

  it('security-audit meta is correct', () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'security-audit')
    expect(wf).toBeDefined()
    expect(wf?.meta.description).toContain('安全审计')
    expect(wf?.meta.phases).toEqual(['scan', 'verify', 'report'])
  })

  it('code-review meta is correct', () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'code-review')
    expect(wf).toBeDefined()
    expect(wf?.meta.description).toContain('代码审查')
    expect(wf?.meta.phases).toEqual(['review', 'merge'])
  })

  it('migration-check meta is correct', () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'migration-check')
    expect(wf).toBeDefined()
    expect(wf?.meta.description).toContain('迁移')
  })

  it('security-audit executes and returns output', async () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'security-audit')
    const ctx = makeMockCtx({
      runSubagents: async (_type, tasks) =>
        tasks.map(() => ({ ok: true, output: JSON.stringify({ findings: [] }) })),
    })
    const result: WorkflowResult = await wf!.execute(ctx)
    expect(result.output).toBeDefined()
    expect(typeof result.output).toBe('string')
  })

  it('code-review executes and returns output', async () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'code-review')
    const ctx = makeMockCtx({
      runSubagents: async (_type, tasks) =>
        tasks.map(() => ({
          ok: true,
          output: JSON.stringify({ findings: [] }),
        })),
    })
    const result = await wf!.execute(ctx)
    expect(result.output).toBeDefined()
  })

  it('migration-check executes and returns output', async () => {
    const wf = BUILTIN_WORKFLOWS.find((w) => w.meta.name === 'migration-check')
    const ctx = makeMockCtx()
    const result = await wf!.execute(ctx)
    expect(result.output).toBeDefined()
  })

  it('all have sourceCode for /workflow show', () => {
    for (const wf of BUILTIN_WORKFLOWS) {
      expect(wf.sourceCode).toBeDefined()
      expect(wf.sourceCode!.length).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/workflows/builtins.test.ts`
Expected: FAIL — module `./builtins.js` not found

- [ ] **Step 3: Write minimal implementation**

Create `src/core/workflows/builtins.ts`:

```typescript
import type { WorkflowContext, WorkflowEntry, WorkflowResult } from './types.js'

// ── security-audit ──

const SECURITY_AUDIT_SOURCE = `export const meta = {
  name: 'security-audit',
  description: '并行安全审计：按目录拆分扫描 → 独立审查员交叉验证 → 汇总报告',
  argsHint: '[扫描目标描述]',
  phases: ['scan', 'verify', 'report'],
}

export default async function workflow(ctx) {
  const { runSubagents, utils, progress, project } = ctx

  progress('拆分代码库为模块...')
  const modules = await utils.splitByDirectory(project.rootDir, { depth: 2 })

  progress(\`并行扫描 \${modules.length} 个模块...\`, { phase: 'scan' })
  const scans = await runSubagents('researcher', modules.map((m) => ({
    assignment: \`你是安全扫描专家。扫描目录 \${m.path} 下的代码，检查以下安全风险：
- SQL 注入风险
- 硬编码密钥 / 密码 / Token
- 权限绕过模式
- XSS / CSRF 风险
- 不安全的依赖使用

文件列表：\${m.files.slice(0, 50).join(', ')}

返回 JSON：{ findings: [{ severity: 'critical|warning|info', file, line, issue, evidence }] }\`,
    description: \`扫描 \${m.name}\`,
  })))

  const allFindings = scans
    .filter((r) => r.ok)
    .flatMap((r) => { try { return JSON.parse(r.output).findings ?? [] } catch { return [] } })

  progress(\`交叉验证 \${allFindings.length} 个发现...\`, { phase: 'verify' })
  const verified = await runSubagents('reviewer', allFindings.map((f) => ({
    assignment: \`对抗审查以下安全发现，判断是否为真实问题还是误报：
\${JSON.stringify(f, null, 2)}

返回 JSON：{ confirmed: boolean, reason: string, adjustedSeverity?: 'critical|warning|info' }\`,
    description: '验证发现',
  })))

  const confirmed = verified
    .filter((r) => r.ok)
    .map((r) => { try { return JSON.parse(r.output) } catch { return null } })
    .filter((v) => v?.confirmed)

  progress('生成报告...', { phase: 'report' })
  const summary = \`扫描 \${modules.length} 个模块，发现 \${allFindings.length} 个候选问题，\${confirmed.length} 个经交叉验证确认。\`

  return { output: summary, data: { confirmed, totalCandidates: allFindings.length } }
}`

const securityAudit: (ctx: WorkflowContext) => Promise<WorkflowResult> = async (ctx) => {
  const { runSubagents, utils, progress, project } = ctx

  progress('拆分代码库为模块...')
  const modules = await utils.splitByDirectory(project.rootDir, { depth: 2 })

  progress(`并行扫描 ${modules.length} 个模块...`, { phase: 'scan' })
  const scans = await runSubagents('researcher', modules.map((m) => ({
    assignment: `你是安全扫描专家。扫描目录 ${m.path} 下的代码，检查以下安全风险：
- SQL 注入风险
- 硬编码密钥 / 密码 / Token
- 权限绕过模式
- XSS / CSRF 风险
- 不安全的依赖使用

文件列表：${m.files.slice(0, 50).join(', ')}

返回 JSON：{ findings: [{ severity: 'critical|warning|info', file, line, issue, evidence }] }`,
    description: `扫描 ${m.name}`,
  })))

  const allFindings = scans
    .filter((r) => r.ok)
    .flatMap((r) => {
      try {
        return JSON.parse(r.output).findings ?? []
      } catch {
        return []
      }
    })

  progress(`交叉验证 ${allFindings.length} 个发现...`, { phase: 'verify' })
  const verified = await runSubagents('reviewer', allFindings.map((f) => ({
    assignment: `对抗审查以下安全发现，判断是否为真实问题还是误报：
${JSON.stringify(f, null, 2)}

返回 JSON：{ confirmed: boolean, reason: string, adjustedSeverity?: 'critical|warning|info' }`,
    description: '验证发现',
  })))

  const confirmed = verified
    .filter((r) => r.ok)
    .map((r) => {
      try {
        return JSON.parse(r.output)
      } catch {
        return null
      }
    })
    .filter((v) => v?.confirmed)

  progress('生成报告...', { phase: 'report' })
  const summary = `扫描 ${modules.length} 个模块，发现 ${allFindings.length} 个候选问题，${confirmed.length} 个经交叉验证确认。`

  return { output: summary, data: { confirmed, totalCandidates: allFindings.length } }
}

// ── code-review ──

const CODE_REVIEW_SOURCE = `export const meta = {
  name: 'code-review',
  description: '多维度代码审查：correctness/security/performance/maintainability 各派独立 reviewer',
  argsHint: '[审查目标路径]',
  phases: ['review', 'merge'],
}

export default async function workflow(ctx) {
  const { runSubagents, progress, project, args } = ctx
  const target = args || project.rootDir

  const dimensions = ['correctness', 'security', 'performance', 'maintainability']

  progress(\`并行 \${dimensions.length} 个维度审查...\`, { phase: 'review' })
  const reviews = await runSubagents('reviewer', dimensions.map((dim) => ({
    assignment: \`你是 \${dim} 维度的代码审查专家。审查 \${target} 下的代码。

关注点：
\${dim === 'correctness' ? '- 逻辑正确性、边界条件、错误处理' : ''}
\${dim === 'security' ? '- 安全漏洞、输入验证、权限控制' : ''}
\${dim === 'performance' ? '- 性能瓶颈、不必要计算、内存泄漏' : ''}
\${dim === 'maintainability' ? '- 代码可读性、重复代码、命名规范' : ''}

返回 JSON：{ findings: [{ severity: 'critical|warning|info', file, line, issue, suggestion }] }\`,
    description: \`\${dim} 审查\`,
    role: dim,
  })))

  const allFindings = reviews
    .filter((r) => r.ok)
    .flatMap((r) => { try { return JSON.parse(r.output).findings ?? [] } catch { return [] } })

  progress('合并去重并生成报告...', { phase: 'merge' })
  // 简单去重：相同 file+line+issue 视为重复
  const seen = new Set()
  const deduped = allFindings.filter((f) => {
    const key = \`\${f.file}:\${f.line}:\${f.issue}\`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const critical = deduped.filter((f) => f.severity === 'critical').length
  const warning = deduped.filter((f) => f.severity === 'warning').length
  const info = deduped.filter((f) => f.severity === 'info').length

  return {
    output: \`审查完成：\${critical} critical, \${warning} warning, \${info} info（共 \${deduped.length} 条）\`,
    data: { findings: deduped, summary: { critical, warning, info, total: deduped.length } },
  }
}`

const codeReview: (ctx: WorkflowContext) => Promise<WorkflowResult> = async (ctx) => {
  const { runSubagents, progress, project, args } = ctx
  const target = args || project.rootDir

  const dimensions = ['correctness', 'security', 'performance', 'maintainability']

  progress(`并行 ${dimensions.length} 个维度审查...`, { phase: 'review' })
  const reviews = await runSubagents('reviewer', dimensions.map((dim) => ({
    assignment: `你是 ${dim} 维度的代码审查专家。审查 ${target} 下的代码。

关注点：
${dim === 'correctness' ? '- 逻辑正确性、边界条件、错误处理' : ''}
${dim === 'security' ? '- 安全漏洞、输入验证、权限控制' : ''}
${dim === 'performance' ? '- 性能瓶颈、不必要计算、内存泄漏' : ''}
${dim === 'maintainability' ? '- 代码可读性、重复代码、命名规范' : ''}

返回 JSON：{ findings: [{ severity: 'critical|warning|info', file, line, issue, suggestion }] }`,
    description: `${dim} 审查`,
    role: dim,
  })))

  const allFindings = reviews
    .filter((r) => r.ok)
    .flatMap((r) => {
      try {
        return JSON.parse(r.output).findings ?? []
      } catch {
        return []
      }
    })

  progress('合并去重并生成报告...', { phase: 'merge' })
  const seen = new Set()
  const deduped = allFindings.filter((f) => {
    const key = `${f.file}:${f.line}:${f.issue}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const critical = deduped.filter((f) => f.severity === 'critical').length
  const warning = deduped.filter((f) => f.severity === 'warning').length
  const info = deduped.filter((f) => f.severity === 'info').length

  return {
    output: `审查完成：${critical} critical, ${warning} warning, ${info} info（共 ${deduped.length} 条）`,
    data: { findings: deduped, summary: { critical, warning, info, total: deduped.length } },
  }
}

// ── migration-check ──

const MIGRATION_CHECK_SOURCE = `export const meta = {
  name: 'migration-check',
  description: '迁移影响检查：分析变更的 breaking changes / deprecated / new features',
  argsHint: '[base-branch或commit]',
  phases: ['diff', 'analyze', 'report'],
}

export default async function workflow(ctx) {
  const { runSubagents, progress, project, args } = ctx
  const baseRef = args || 'HEAD~1'

  progress(\`分析 \${baseRef} 到当前版本的变更...\`, { phase: 'diff' })

  const categories = ['breaking-changes', 'deprecated', 'new-features']

  progress(\`并行分析 \${categories.length} 个类别...\`, { phase: 'analyze' })
  const analyses = await runSubagents('researcher', categories.map((cat) => ({
    assignment: \`你是代码迁移分析专家。分析项目 \${project.rootDir} 从 \${baseRef} 到当前的变更，
聚焦 \${cat === 'breaking-changes' ? '破坏性变更（API 签名变更、删除、行为变更）' : cat === 'deprecated' ? '已废弃的功能和 API' : '新增功能和特性'}。

返回 JSON：{ items: [{ category: '${cat}', description, files, impact: 'high|medium|low' }] }\`,
    description: \`${cat} 分析\`,
    role: cat,
  })))

  const allItems = analyses
    .filter((r) => r.ok)
    .flatMap((r) => { try { return JSON.parse(r.output).items ?? [] } catch { return [] } })

  progress('生成迁移报告...', { phase: 'report' })
  const high = allItems.filter((i) => i.impact === 'high').length
  const medium = allItems.filter((i) => i.impact === 'medium').length
  const low = allItems.filter((i) => i.impact === 'low').length

  return {
    output: \`迁移检查完成：\${allItems.length} 个变更项（\${high} high, \${medium} medium, \${low} low）\`,
    data: { items: allItems, summary: { high, medium, low, total: allItems.length } },
  }
}`

const migrationCheck: (ctx: WorkflowContext) => Promise<WorkflowResult> = async (ctx) => {
  const { runSubagents, progress, project, args } = ctx
  const baseRef = args || 'HEAD~1'

  progress(`分析 ${baseRef} 到当前版本的变更...`, { phase: 'diff' })

  const categories = ['breaking-changes', 'deprecated', 'new-features']

  progress(`并行分析 ${categories.length} 个类别...`, { phase: 'analyze' })
  const analyses = await runSubagents('researcher', categories.map((cat) => ({
    assignment: `你是代码迁移分析专家。分析项目 ${project.rootDir} 从 ${baseRef} 到当前的变更，
聚焦 ${cat === 'breaking-changes' ? '破坏性变更（API 签名变更、删除、行为变更）' : cat === 'deprecated' ? '已废弃的功能和 API' : '新增功能和特性'}。

返回 JSON：{ items: [{ category: '${cat}', description, files, impact: 'high|medium|low' }] }`,
    description: `${cat} 分析`,
    role: cat,
  })))

  const allItems = analyses
    .filter((r) => r.ok)
    .flatMap((r) => {
      try {
        return JSON.parse(r.output).items ?? []
      } catch {
        return []
      }
    })

  progress('生成迁移报告...', { phase: 'report' })
  const high = allItems.filter((i) => i.impact === 'high').length
  const medium = allItems.filter((i) => i.impact === 'medium').length
  const low = allItems.filter((i) => i.impact === 'low').length

  return {
    output: `迁移检查完成：${allItems.length} 个变更项（${high} high, ${medium} medium, ${low} low）`,
    data: { items: allItems, summary: { high, medium, low, total: allItems.length } },
  }
}

// ── barrel ──

const BUILTIN_WORKFLOWS: WorkflowEntry[] = [
  {
    meta: {
      name: 'security-audit',
      description: '并行安全审计：按目录拆分扫描 → 独立审查员交叉验证 → 汇总报告',
      argsHint: '[扫描目标描述]',
      phases: ['scan', 'verify', 'report'],
    },
    source: 'builtin',
    execute: securityAudit,
    sourceCode: SECURITY_AUDIT_SOURCE,
  },
  {
    meta: {
      name: 'code-review',
      description: '多维度代码审查：correctness/security/performance/maintainability 各派独立 reviewer',
      argsHint: '[审查目标路径]',
      phases: ['review', 'merge'],
    },
    source: 'builtin',
    execute: codeReview,
    sourceCode: CODE_REVIEW_SOURCE,
  },
  {
    meta: {
      name: 'migration-check',
      description: '迁移影响检查：分析变更的 breaking changes / deprecated / new features',
      argsHint: '[base-branch或commit]',
      phases: ['diff', 'analyze', 'report'],
    },
    source: 'builtin',
    execute: migrationCheck,
    sourceCode: MIGRATION_CHECK_SOURCE,
  },
]

export { BUILTIN_WORKFLOWS }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/workflows/builtins.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/workflows/builtins.ts src/core/workflows/builtins.test.ts
git commit -m "feat(workflow): add 3 builtin workflow templates"
```

---

## Task 5: 工作流执行上下文

**Files:**
- Create: `src/core/workflows/context.ts`
- Test: `src/core/workflows/context.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/workflows/context.test.ts`:

```typescript
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkflowContext } from './context.js'
import type { AgentDependencies, AgentState } from '../types.js'
import type { SubAgentResult } from '../../shared/types/tool.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'wf-ctx-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function makeMockDeps(
  runSubAgentImpl?: (req: unknown) => Promise<SubAgentResult>,
): AgentDependencies {
  return {
    db: {} as AgentDependencies['db'],
    llmRegistry: {} as AgentDependencies['llmRegistry'],
    toolRegistry: {} as AgentDependencies['toolRegistry'],
    permission: {} as AgentDependencies['permission'],
    config: {} as AgentDependencies['config'],
    cwd: tmpDir,
    agentRegistry: {
      get: () => ({ name: 'test', description: '', systemPrompt: '', mode: 'subagent' }),
    },
  } as unknown as AgentDependencies
}

function makeMockParent(): AgentState {
  return {
    session: { id: 'test-session', title: 'test', projectId: null },
    messages: [],
    config: { provider: 'test', model: 'test', tools: [], plugins: [], agentName: 'default' },
    status: { _tag: 'idle' },
    tools: [],
  } as unknown as AgentState
}

describe('buildWorkflowContext', () => {
  it('creates context with project info', () => {
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: 'test-args',
      onProgress: () => {},
      projectName: 'my-project',
    })
    expect(ctx.project.rootDir).toBe(tmpDir)
    expect(ctx.project.name).toBe('my-project')
    expect(ctx.args).toBe('test-args')
  })

  it('runSubagent delegates to runSubAgent and maps success', async () => {
    const runSubAgentFn = vi.fn().mockResolvedValue({
      _tag: 'success',
      output: 'task done',
      sessionId: 'child-1',
      data: { result: 'ok' },
    } satisfies SubAgentResult)
    const deps = makeMockDeps()
    const ctx = buildWorkflowContext({
      deps,
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
      runSubAgentFn,
    })
    const result = await ctx.runSubagent('researcher', { assignment: 'do stuff' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output).toBe('task done')
      expect(result.data).toEqual({ result: 'ok' })
    }
    expect(runSubAgentFn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'researcher',
        prompt: 'do stuff',
      }),
    )
  })

  it('runSubagent maps error result', async () => {
    const runSubAgentFn = vi.fn().mockResolvedValue({
      _tag: 'error',
      error: 'agent failed',
    } satisfies SubAgentResult)
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
      runSubAgentFn,
    })
    const result = await ctx.runSubagent('coder', { assignment: 'fail task' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('agent failed')
    }
  })

  it('runSubagents runs all tasks and returns ordered results', async () => {
    let callCount = 0
    const runSubAgentFn = vi.fn().mockImplementation(() => {
      callCount++
      return Promise.resolve({
        _tag: 'success' as const,
        output: `result-${callCount}`,
        sessionId: `s-${callCount}`,
      })
    })
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
      runSubAgentFn,
    })
    const results = await ctx.runSubagents('coder', [
      { assignment: 'task1' },
      { assignment: 'task2' },
      { assignment: 'task3' },
    ])
    expect(results.length).toBe(3)
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('progress callback fires', () => {
    const onProgress = vi.fn()
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress,
    })
    ctx.progress('step 1', { phase: 'scan' })
    expect(onProgress).toHaveBeenCalledWith('step 1', { phase: 'scan' })
  })

  it('utils.glob finds files', async () => {
    await mkdir(join(tmpDir, 'sub'), { recursive: true })
    await writeFile(join(tmpDir, 'a.ts'), 'x')
    await writeFile(join(tmpDir, 'b.ts'), 'y')
    await writeFile(join(tmpDir, 'sub', 'c.ts'), 'z')
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
    })
    const files = await ctx.utils.glob('*.ts')
    expect(files.length).toBeGreaterThanOrEqual(2)
  })

  it('utils.read reads file content', async () => {
    await writeFile(join(tmpDir, 'hello.txt'), 'line1\nline2\nline3')
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
    })
    const content = await ctx.utils.read('hello.txt')
    expect(content).toContain('line1')
  })

  it('utils.read with range reads subset', async () => {
    await writeFile(join(tmpDir, 'ranged.txt'), 'l1\nl2\nl3\nl4\nl5')
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
    })
    const content = await ctx.utils.read('ranged.txt', { start: 2, end: 4 })
    expect(content).toContain('l2')
    expect(content).toContain('l3')
    expect(content).not.toContain('l5')
  })

  it('utils.splitByDirectory splits subdirectories', async () => {
    await mkdir(join(tmpDir, 'modA'), { recursive: true })
    await mkdir(join(tmpDir, 'modB'), { recursive: true })
    await writeFile(join(tmpDir, 'modA', 'a.ts'), 'x')
    await writeFile(join(tmpDir, 'modB', 'b.ts'), 'y')
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
    })
    const modules = await ctx.utils.splitByDirectory(tmpDir, { depth: 1 })
    const names = modules.map((m) => m.name)
    expect(names).toContain('modA')
    expect(names).toContain('modB')
  })

  it('utils.grep finds matching lines', async () => {
    await writeFile(join(tmpDir, 'search.ts'), 'const hello = "world"\nconst foo = "bar"')
    const ctx = buildWorkflowContext({
      deps: makeMockDeps(),
      parent: makeMockParent(),
      args: '',
      onProgress: () => {},
    })
    const results = await ctx.utils.grep('hello')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]?.text).toContain('hello')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/workflows/context.test.ts`
Expected: FAIL — module `./context.js` not found

- [ ] **Step 3: Write minimal implementation**

Create `src/core/workflows/context.ts`:

```typescript
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { SubAgentRequest, SubAgentResult } from '../../shared/types/tool.js'
import type { AgentDependencies, AgentState } from '../types.js'
import type { WorkflowAgentResult, WorkflowContext } from './types.js'

/** buildWorkflowContext 的参数。 */
type BuildContextOpts = {
  deps: AgentDependencies
  parent: AgentState
  args: string
  onProgress: (message: string, detail?: unknown) => void
  /** 项目名（从 ProjectInfo 传入）。 */
  projectName?: string
  /** 测试注入：覆盖内部 runSubAgent 调用。生产环境省略，走 deps 关联的 loop.runSubAgent。 */
  runSubAgentFn?: (request: SubAgentRequest) => Promise<SubAgentResult>
}

/** SubAgentResult → WorkflowAgentResult 映射。 */
function mapResult(result: SubAgentResult): WorkflowAgentResult {
  if (result._tag === 'success') {
    return { ok: true, output: result.output, data: result.data }
  }
  if (result._tag === 'error') {
    return { ok: false, error: result.error }
  }
  // running（后台模式）— 工作流不使用后台，视为错误
  return { ok: false, error: 'subagent returned running (background not supported in workflows)' }
}

/** 构建 WorkflowContext，注入 runSubagent/utils/progress。 */
function buildWorkflowContext(opts: BuildContextOpts): WorkflowContext {
  const { deps, parent, args, onProgress, projectName, runSubAgentFn } = opts
  const rootDir = deps.cwd

  // 默认 runSubAgent：通过动态 import 避免循环依赖
  const doRunSubAgent =
    runSubAgentFn ??
    (async (request: SubAgentRequest) => {
      const { runSubAgent } = await import('../loop.js')
      return runSubAgent(deps, parent, request)
    })

  return {
    project: {
      rootDir,
      name: projectName ?? 'project',
    },
    args,

    runSubagent: async (type, params) => {
      const result = await doRunSubAgent({
        agentType: type,
        prompt: params.assignment,
        description: params.description,
        model: params.model,
      })
      return mapResult(result)
    },

    runSubagents: async (type, tasks, context) => {
      // 串行→并行升级：先实现 concurrency pool
      const { mapWithConcurrencyLimit } = await import('../agents/parallel.js')
      const concurrency = 3
      const { results } = await mapWithConcurrencyLimit(
        tasks,
        concurrency,
        async (task) => {
          const result = await doRunSubAgent({
            agentType: type,
            prompt: task.assignment,
            description: task.description,
            role: task.role,
            context,
          })
          return mapResult(result)
        },
      )
      return results.filter((r): r is WorkflowAgentResult => r !== undefined)
    },

    progress: onProgress,

    utils: {
      glob: async (pattern: string) => {
        return globRecursive(rootDir, pattern)
      },

      grep: async (pattern: string, searchPath?: string) => {
        const baseDir = searchPath ? resolve(rootDir, searchPath) : rootDir
        return grepRecursive(baseDir, pattern, rootDir)
      },

      read: async (filePath: string, range?: { start: number; end: number }) => {
        const absPath = resolve(rootDir, filePath)
        const content = await readFile(absPath, 'utf-8')
        if (!range) return content
        const lines = content.split('\n')
        return lines.slice(range.start - 1, range.end).join('\n')
      },

      splitByDirectory: async (
        dir: string,
        opts?: { depth?: number; ignore?: string[] },
      ) => {
        return splitByDir(resolve(rootDir, dir), opts?.depth ?? 1, opts?.ignore ?? [])
      },
    },
  }
}

// ── 工具函数 ──

/** 递归 glob（简单实现，匹配文件名后缀或通配符）。 */
async function globRecursive(rootDir: string, pattern: string): Promise<string[]> {
  const results: string[] = []
  // 将 pattern 转为正则（支持 * 和 .ext 形式）
  const regex = new RegExp(
    pattern.replace(/\./g, '\\.').replace(/\*/g, '.*'),
  )

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (regex.test(entry.name)) {
        results.push(relative(rootDir, fullPath))
      }
    }
  }

  await walk(rootDir)
  return results
}

/** 递归 grep（正则搜索文件内容）。 */
async function grepRecursive(
  baseDir: string,
  pattern: string,
  rootDir: string,
): Promise<Array<{ path: string; line: number; text: string }>> {
  const results: Array<{ path: string; line: number; text: string }> = []
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else {
        try {
          const content = await readFile(fullPath, 'utf-8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i]!)) {
              results.push({
                path: relative(rootDir, fullPath),
                line: i + 1,
                text: lines[i]!.trim(),
              })
            }
          }
        } catch {
          // 二进制文件等，跳过
        }
      }
    }
  }

  await walk(baseDir)
  return results
}

/** 按子目录拆分模块。 */
async function splitByDir(
  rootDir: string,
  depth: number,
  ignore: string[],
): Promise<Array<{ name: string; path: string; files: string[] }>> {
  const modules: Array<{ name: string; path: string; files: string[] }> = []

  async function collectFiles(dir: string): Promise<string[]> {
    const files: string[] = []
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return files
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (ignore.includes(entry.name)) continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...(await collectFiles(fullPath)))
      } else {
        files.push(relative(rootDir, fullPath))
      }
    }
    return files
  }

  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return modules
  }

  const subdirs = entries.filter(
    (e) => e.isDirectory() && !e.name.startsWith('.') && !ignore.includes(e.name),
  )

  if (subdirs.length === 0) {
    // 没有子目录，整个目录作为一个模块
    modules.push({ name: 'root', path: rootDir, files: await collectFiles(rootDir) })
    return modules
  }

  for (const subdir of subdirs) {
    const dirPath = join(rootDir, subdir.name)
    modules.push({
      name: subdir.name,
      path: dirPath,
      files: await collectFiles(dirPath),
    })
  }

  return modules
}

export { buildWorkflowContext }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/workflows/context.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/workflows/context.ts src/core/workflows/context.test.ts
git commit -m "feat(workflow): add workflow execution context builder"
```

---

## Task 6: 工作流执行引擎

**Files:**
- Create: `src/core/workflows/runtime.ts`
- Test: `src/core/workflows/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/workflows/runtime.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowContext, WorkflowEntry, WorkflowResult } from './types.js'
import { createWorkflowRegistry } from './registry.js'
import { executeWorkflow } from './runtime.js'
import type { AgentDependencies, AgentState } from '../types.js'

function makeMockDeps(): AgentDependencies {
  return {
    db: {} as AgentDependencies['db'],
    llmRegistry: {} as AgentDependencies['llmRegistry'],
    toolRegistry: {} as AgentDependencies['toolRegistry'],
    permission: {} as AgentDependencies['permission'],
    config: {} as AgentDependencies['config'],
    cwd: '/tmp',
  } as unknown as AgentDependencies
}

function makeMockParent(): AgentState {
  return {
    session: { id: 'test', title: 't', projectId: null },
    messages: [],
    config: { provider: 'x', model: 'x', tools: [], plugins: [], agentName: 'default' },
    status: { _tag: 'idle' },
    tools: [],
  } as unknown as AgentState
}

describe('executeWorkflow', () => {
  it('returns error for unknown workflow name', async () => {
    const registry = createWorkflowRegistry()
    const result = await executeWorkflow({
      registry,
      name: 'nonexistent',
      args: '',
      deps: makeMockDeps(),
      parent: makeMockParent(),
    })
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.message).toContain('nonexistent')
    }
  })

  it('executes workflow and returns text result', async () => {
    const registry = createWorkflowRegistry()
    const entry: WorkflowEntry = {
      meta: { name: 'simple', description: 'simple wf' },
      source: 'builtin',
      execute: async () => ({ output: 'workflow completed' }),
    }
    registry.register(entry)
    const result = await executeWorkflow({
      registry,
      name: 'simple',
      args: '',
      deps: makeMockDeps(),
      parent: makeMockParent(),
    })
    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toBe('workflow completed')
    }
  })

  it('returns error message when workflow throws', async () => {
    const registry = createWorkflowRegistry()
    const entry: WorkflowEntry = {
      meta: { name: 'crash', description: 'crashes' },
      source: 'builtin',
      execute: async () => {
        throw new Error('boom')
      },
    }
    registry.register(entry)
    const result = await executeWorkflow({
      registry,
      name: 'crash',
      args: '',
      deps: makeMockDeps(),
      parent: makeMockParent(),
    })
    expect(result._tag).toBe('error')
    if (result._tag === 'error') {
      expect(result.message).toContain('boom')
    }
  })

  it('passes args to workflow context', async () => {
    const registry = createWorkflowRegistry()
    let receivedArgs = ''
    const entry: WorkflowEntry = {
      meta: { name: 'argcheck', description: 'checks args' },
      source: 'builtin',
      execute: async (ctx: WorkflowContext) => {
        receivedArgs = ctx.args
        return { output: 'ok' }
      },
    }
    registry.register(entry)
    await executeWorkflow({
      registry,
      name: 'argcheck',
      args: 'my-args-here',
      deps: makeMockDeps(),
      parent: makeMockParent(),
    })
    expect(receivedArgs).toBe('my-args-here')
  })

  it('progress callback fires during execution', async () => {
    const registry = createWorkflowRegistry()
    const entry: WorkflowEntry = {
      meta: { name: 'progress-test', description: 'p' },
      source: 'builtin',
      execute: async (ctx: WorkflowContext) => {
        ctx.progress('step 1')
        ctx.progress('step 2')
        return { output: 'done' }
      },
    }
    registry.register(entry)
    const onProgress = vi.fn()
    await executeWorkflow({
      registry,
      name: 'progress-test',
      args: '',
      deps: makeMockDeps(),
      parent: makeMockParent(),
      onProgress,
    })
    expect(onProgress).toHaveBeenCalledWith('step 1', undefined)
    expect(onProgress).toHaveBeenCalledWith('step 2', undefined)
  })

  it('default output when workflow returns empty result', async () => {
    const registry = createWorkflowRegistry()
    const entry: WorkflowEntry = {
      meta: { name: 'empty', description: 'no output' },
      source: 'builtin',
      execute: async () => ({}),
    }
    registry.register(entry)
    const result = await executeWorkflow({
      registry,
      name: 'empty',
      args: '',
      deps: makeMockDeps(),
      parent: makeMockParent(),
    })
    expect(result._tag).toBe('text')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/workflows/runtime.test.ts`
Expected: FAIL — module `./runtime.js` not found

- [ ] **Step 3: Write minimal implementation**

Create `src/core/workflows/runtime.ts`:

```typescript
import type { AgentDependencies, AgentState, CommandResult } from '../types.js'
import { buildWorkflowContext } from './context.js'
import type { WorkflowRegistry } from './registry.js'

/** executeWorkflow 的参数。 */
type ExecuteWorkflowOpts = {
  registry: WorkflowRegistry
  name: string
  args: string
  deps: AgentDependencies
  parent: AgentState
  onProgress?: (message: string, detail?: unknown) => void
}

/**
 * 执行工作流：查注册表 → 构建 ctx → 调用 entry.execute → 返回 CommandResult。
 *
 * 工作流 return 的 output 作为 text 返回；异常捕获为 error。
 */
async function executeWorkflow(opts: ExecuteWorkflowOpts): Promise<CommandResult> {
  const { registry, name, args, deps, parent, onProgress } = opts

  const entry = registry.get(name)
  if (!entry) {
    const available = registry.list().map((e) => e.meta.name).join(', ')
    return {
      _tag: 'error',
      message: `Unknown workflow: "${name}". Available: ${available || '(none)'}`,
    }
  }

  const ctx = buildWorkflowContext({
    deps,
    parent,
    args,
    onProgress: onProgress ?? (() => {}),
  })

  try {
    const result = await entry.execute(ctx)
    return {
      _tag: 'text',
      text: result.output ?? 'Workflow completed (no output).',
    }
  } catch (e) {
    return {
      _tag: 'error',
      message: `Workflow "${name}" failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

export { executeWorkflow }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/workflows/runtime.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/workflows/runtime.ts src/core/workflows/runtime.test.ts
git commit -m "feat(workflow): add workflow execution engine"
```

---

## Task 7: 工作流 barrel export + createWorkflowRegistry 工厂

**Files:**
- Create: `src/core/workflows/index.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1: Write index.ts barrel**

Create `src/core/workflows/index.ts`:

```typescript
export { BUILTIN_WORKFLOWS } from './builtins.js'
export { buildWorkflowContext } from './context.js'
export { discoverWorkflows } from './discovery.js'
export { executeWorkflow } from './runtime.js'
export type { WorkflowRegistry } from './registry.js'
export { createWorkflowRegistry } from './registry.js'
export type {
  WorkflowAgentResult,
  WorkflowContext,
  WorkflowEntry,
  WorkflowMeta,
  WorkflowModule,
  WorkflowResult,
  WorkflowUtils,
} from './types.js'
```

- [ ] **Step 2: Add a createWorkflowRegistry factory function that loads builtins + discovery**

Modify `src/core/workflows/registry.ts` — add a factory function at the end:

```typescript
// 追加到 registry.ts 文件末尾

import { BUILTIN_WORKFLOWS } from './builtins.js'
import { discoverWorkflows } from './discovery.js'

/**
 * 创建并填充工作流注册表：
 *  1. 注册内置工作流
 *  2. 发现并注册项目 `.c0de/workflows/*.js`
 *  后注册覆盖同名（project > builtin）。
 */
async function createAndPopulateRegistry(projectDir: string): Promise<WorkflowRegistry> {
  const registry = createWorkflowRegistry()
  // 1. 内置
  for (const wf of BUILTIN_WORKFLOWS) {
    registry.register(wf)
  }
  // 2. 项目级
  const discovered = await discoverWorkflows(projectDir)
  for (const wf of discovered) {
    registry.register(wf)
  }
  return registry
}

export { createAndPopulateRegistry }
```

- [ ] **Step 3: Export from core barrel**

Add to `src/core/index.ts` (after the existing workflow.ts export line):

```typescript
export {
  BUILTIN_WORKFLOWS,
  buildWorkflowContext,
  createAndPopulateRegistry,
  createWorkflowRegistry,
  discoverWorkflows,
  executeWorkflow,
} from './workflows/index.js'
export type {
  WorkflowAgentResult,
  WorkflowContext,
  WorkflowEntry,
  WorkflowMeta,
  WorkflowRegistry,
  WorkflowResult,
} from './workflows/index.js'
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to workflows module

- [ ] **Step 5: Commit**

```bash
git add src/core/workflows/index.ts src/core/workflows/registry.ts src/core/index.ts
git commit -m "feat(workflow): add barrel export and populated registry factory"
```

---

## Task 8: CommandContext 类型 + `/workflow` slash 命令

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/slash.ts`
- Test: `src/core/slash.test.ts` (追加)

- [ ] **Step 1: Write the failing tests**

Append to `src/core/slash.test.ts` (inside the last `describe` or as a new describe block before its closing):

```typescript
describe('workflow command', () => {
  it('is registered in builtin commands', () => {
    const reg = createSlashRegistry()
    expect(reg.has('workflow')).toBe(true)
    const cmd = reg.get('workflow')
    expect(cmd?.description).toContain('workflow')
  })

  it('/workflow without subcommand lists available workflows', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')!
    const result = (await cmd.execute('', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toContain('Available workflows')
    }
  })

  it('/workflow show <name> displays source code', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')!
    const result = (await cmd.execute('show security-audit', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('text')
    if (result._tag === 'text') {
      expect(result.text).toContain('security-audit')
    }
  })

  it('/workflow show <unknown> returns error', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')!
    const result = (await cmd.execute('show nonexistent', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('error')
  })

  it('/workflow run <unknown> returns error', async () => {
    const reg = createSlashRegistry()
    const cmd = reg.get('workflow')!
    const result = (await cmd.execute('run nonexistent', {
      cwd: '/',
      config: DEFAULT_CONFIG,
      deps,
    })) as CommandResult
    expect(result._tag).toBe('error')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/slash.test.ts`
Expected: FAIL — workflow command not registered

- [ ] **Step 3: Update CommandContext type**

In `src/core/types.ts`, find the `CommandContext` type and add the optional field:

```typescript
type CommandContext = {
  cwd: string
  config: Config
  deps: AgentDependencies
  workflowRegistry?: import('./workflows/registry.js').WorkflowRegistry
}
```

- [ ] **Step 4: Implement the workflowCommand**

Add to `src/core/slash.ts` (before `builtinCommands`):

```typescript
import { createAndPopulateRegistry, createWorkflowRegistry } from './workflows/index.js'
import { BUILTIN_WORKFLOWS } from './workflows/index.js'
import { executeWorkflow } from './workflows/runtime.js'

const workflowCommand: SlashCommand = {
  name: 'workflow',
  description: 'Manage and run workflows',
  argsHint: '[run|show|list] [name] [args]',
  execute: async (args, ctx) => {
    const parts = args.split(/\s+/).filter(Boolean)
    const subcommand = parts[0] ?? 'list'

    // 获取或创建 registry
    let registry = ctx.workflowRegistry
    if (!registry) {
      // 回退：创建仅含内置的注册表（无 discovery）
      registry = createWorkflowRegistry()
      for (const wf of BUILTIN_WORKFLOWS) {
        registry.register(wf)
      }
    }

    if (subcommand === 'list' || subcommand === 'list') {
      const workflows = registry.list()
      const lines = ['Available workflows:']
      for (const wf of workflows) {
        const phases = wf.meta.phases ? ` [${wf.meta.phases.join('→')}]` : ''
        lines.push(`  /${wf.meta.name}${phases}  — ${wf.meta.description} (${wf.source})`)
      }
      lines.push('')
      lines.push('Usage: /workflow run <name> [args]')
      return { _tag: 'text', text: lines.join('\n') }
    }

    if (subcommand === 'show') {
      const name = parts[1]
      if (!name) return { _tag: 'error', message: 'Usage: /workflow show <name>' }
      const wf = registry.get(name)
      if (!wf) {
        return { _tag: 'error', message: `Unknown workflow: ${name}` }
      }
      const code = wf.sourceCode ?? '// source not available'
      return { _tag: 'text', text: `// ${wf.meta.name}: ${wf.meta.description}\n\n${code}` }
    }

    if (subcommand === 'run') {
      const name = parts[1]
      if (!name) return { _tag: 'error', message: 'Usage: /workflow run <name> [args]' }
      const wfArgs = parts.slice(2).join(' ')

      // 构建最小 parent state（slash 命令无活跃 agent state）
      const { createAgent } = await import('./agent.js')
      const agentConfig = {
        provider: ctx.config.defaultProvider,
        model: ctx.config.defaultModel,
        tools: [],
        plugins: ctx.config.plugins.enabled,
        agentName: 'default',
      }
      const parent = await createAgent(
        { id: 'workflow-runner', title: 'workflow', projectId: null },
        agentConfig,
        ctx.deps,
      )

      return executeWorkflow({
        registry,
        name,
        args: wfArgs,
        deps: ctx.deps,
        parent,
      })
    }

    return {
      _tag: 'error',
      message: `Unknown subcommand: ${subcommand}. Use: list, run, show`,
    }
  },
}
```

Then add `workflowCommand` to the `builtinCommands` array:

```typescript
const builtinCommands: SlashCommand[] = [
  helpCommand,
  compactCommand,
  modelCommand,
  clearCommand,
  forkCommand,
  configCommand,
  workflowCommand,
]
```

Also update the help text in `helpCommand.execute` to include the workflow command. Find the lines array in helpCommand and add:

```typescript
      '  /workflow [list|run|show]  Manage and run workflows',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/core/slash.test.ts`
Expected: PASS (all existing + 5 new tests)

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/slash.ts src/core/slash.test.ts
git commit -m "feat(workflow): add /workflow slash command"
```

---

## Task 9: workflowz steering 增强

**Files:**
- Modify: `src/core/workflow.ts`
- Modify: `src/core/workflow.test.ts` (追加)
- Modify: `src/server/routes/chat.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/core/workflow.test.ts`:

```typescript
import { buildWorkflowNotice } from './workflow.js'

describe('buildWorkflowNotice', () => {
  it('appends registered workflows section when workflows provided', () => {
    const notice = buildWorkflowNotice([
      { name: 'security-audit', description: '安全审计' },
      { name: 'code-review', description: '代码审查' },
    ])
    expect(notice).toContain('registered-workflows')
    expect(notice).toContain('security-audit')
    expect(notice).toContain('code-review')
  })

  it('works without workflows (backward compatible)', () => {
    const notice = buildWorkflowNotice([])
    expect(notice).toContain('workflowz')
    expect(notice).not.toContain('registered-workflows')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/workflow.test.ts`
Expected: FAIL — `buildWorkflowNotice` not exported

- [ ] **Step 3: Implement buildWorkflowNotice**

In `src/core/workflow.ts`, keep `WORKFLOW_NOTICE` content but refactor to a function. Add after the existing `WORKFLOW_NOTICE` constant:

```typescript
/**
 * 构建工作流 steering 通知：基础通知 + 可选的已注册工作流列表。
 *
 * 无工作流时退化为纯基础通知（向后兼容）。
 */
function buildWorkflowNotice(
  workflows?: Array<{ name: string; description: string }>,
): string {
  const registeredSection =
    workflows && workflows.length > 0
      ? `\n<registered-workflows>
Available workflow templates you can invoke with the task tool's workflow parameter:
${workflows.map((w) => `- ${w.name}: ${w.description}`).join('\n')}
If none fit, orchestrate inline using runSubagent fan-out as described below.
</registered-workflows>`
      : ''

  return WORKFLOW_NOTICE + registeredSection
}
```

Add `buildWorkflowNotice` to the exports of `workflow.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/workflow.test.ts`
Expected: PASS

- [ ] **Step 5: Update chat.ts to use buildWorkflowNotice**

In `src/server/routes/chat.ts`, replace the workflow injection block:

Find:
```typescript
      if (containsWorkflow(message)) {
        injectSteering(state, WORKFLOW_NOTICE)
      }
```

Replace with:
```typescript
      if (containsWorkflow(message)) {
        const wfList = ctx.workflowRegistry
          ? ctx.workflowRegistry.list().map((w) => ({
              name: w.meta.name,
              description: w.meta.description,
            }))
          : []
        injectSteering(state, buildWorkflowNotice(wfList))
      }
```

Update the import at top of chat.ts:

```typescript
import { buildWorkflowNotice, containsWorkflow } from '../../core/workflow.js'
```

(Remove `WORKFLOW_NOTICE` from the import.)

- [ ] **Step 6: Verify chat test still passes**

Run: `npx vitest run src/server/routes/chat.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/workflow.ts src/core/workflow.test.ts src/server/routes/chat.ts
git commit -m "feat(workflow): enhance workflowz steering with registered workflows list"
```

---

## Task 10: Server 接线 — ServerContext + 路由

**Files:**
- Modify: `src/server/types.ts`
- Modify: `src/server/context.ts`
- Create: `src/server/routes/workflows.ts`
- Modify: `src/server/app.ts`
- Modify: `src/server/routes/chat.ts` (注入 workflowRegistry)

- [ ] **Step 1: Add workflowRegistry to ServerContext type**

In `src/server/types.ts`, add to `ServerContext`:

```typescript
  /** 工作流注册表（spec: dynamic-workflow-design）。 */
  workflowRegistry?: import('../core/workflows/registry.js').WorkflowRegistry
```

- [ ] **Step 2: Create workflows route**

Create `src/server/routes/workflows.ts`:

```typescript
import { streamSSE } from 'hono/streaming'
import { createWorkflowRegistry } from '../../core/workflows/index.js'
import { executeWorkflow } from '../../core/workflows/runtime.js'
import { createAgent } from '../../core/agent.js'
import type { ServerContext } from '../types.js'
import { apiError } from '../utils.js'

/** 创建工作流 REST API 路由。 */
function createWorkflowsRoute(ctx: ServerContext) {
  const app = new Hono()

  // GET / — 列出所有工作流
  app.get('/', (c) => {
    const registry = ctx.workflowRegistry
    if (!registry) {
      return c.json({ workflows: [] })
    }
    const workflows = registry.list().map((entry) => ({
      name: entry.meta.name,
      description: entry.meta.description,
      argsHint: entry.meta.argsHint,
      phases: entry.meta.phases,
      source: entry.source,
    }))
    return c.json({ workflows })
  })

  // GET /:name — 元数据 + 源码
  app.get('/:name', (c) => {
    const name = c.req.param('name')
    const registry = ctx.workflowRegistry
    if (!registry) {
      return apiError(c, 404, 'NOT_FOUND', 'Workflow registry not initialized')
    }
    const entry = registry.get(name)
    if (!entry) {
      return apiError(c, 404, 'NOT_FOUND', `Workflow "${name}" not found`)
    }
    return c.json({
      name: entry.meta.name,
      description: entry.meta.description,
      argsHint: entry.meta.argsHint,
      phases: entry.meta.phases,
      source: entry.source,
      sourceCode: entry.sourceCode,
    })
  })

  // POST /:name/run — 执行工作流（SSE 推送进度）
  app.post('/:name/run', async (c) => {
    const name = c.req.param('name')
    const registry = ctx.workflowRegistry
    if (!registry) {
      return apiError(c, 500, 'NOT_INITIALIZED', 'Workflow registry not initialized')
    }
    const entry = registry.get(name)
    if (!entry) {
      return apiError(c, 404, 'NOT_FOUND', `Workflow "${name}" not found`)
    }

    const body = await c.req.json().catch(() => ({}))
    const args = (body as { args?: string })?.args ?? ''

    // 构建 parent agent state
    const agentConfig = {
      provider: ctx.config.defaultProvider,
      model: ctx.config.defaultModel,
      tools: [],
      plugins: ctx.config.plugins.enabled,
      agentName: 'default',
    }
    const parent = await createAgent(
      { id: `wf-${name}-${Date.now()}`, title: `workflow:${name}`, projectId: null },
      agentConfig,
      {
        db: ctx.db,
        llmRegistry: ctx.llmRegistry,
        toolRegistry: ctx.toolRegistry,
        permission: ctx.permissionStore,
        config: ctx.config,
        cwd: ctx.cwd,
        agentRegistry: ctx.agentRegistry,
      },
    )

    return streamSSE(c, async (stream) => {
      const deps = {
        db: ctx.db,
        llmRegistry: ctx.llmRegistry,
        toolRegistry: ctx.toolRegistry,
        permission: ctx.permissionStore,
        config: ctx.config,
        cwd: ctx.cwd,
        agentRegistry: ctx.agentRegistry,
      }

      try {
        const result = await executeWorkflow({
          registry,
          name,
          args,
          deps,
          parent,
          onProgress: async (message, detail) => {
            await stream.writeSSE({
              event: 'progress',
              data: JSON.stringify({ message, detail }),
            })
          },
        })

        await stream.writeSSE({
          event: 'result',
          data: JSON.stringify(result),
        })
      } catch (e) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            _tag: 'error',
            message: e instanceof Error ? e.message : String(e),
          }),
        })
      }
    })
  })

  // DELETE /:name — 删除（仅非 builtin）
  app.delete('/:name', (c) => {
    const name = c.req.param('name')
    const registry = ctx.workflowRegistry
    if (!registry) {
      return apiError(c, 500, 'NOT_INITIALIZED', 'Workflow registry not initialized')
    }
    const entry = registry.get(name)
    if (!entry) {
      return apiError(c, 404, 'NOT_FOUND', `Workflow "${name}" not found`)
    }
    if (entry.source === 'builtin') {
      return apiError(c, 400, 'BAD_REQUEST', 'Cannot delete builtin workflow')
    }
    registry.delete(name)
    return c.json({ ok: true })
  })

  return app
}

export { createWorkflowsRoute }
```

Note: Check if `apiError` exists in `src/server/utils.ts` or a similar location. If not, use inline `c.json({ error: { ... } }, 404)` instead.

- [ ] **Step 3: Register route in app.ts**

In `src/server/app.ts`, add the import:

```typescript
import { createWorkflowsRoute } from './routes/workflows.js'
```

Add the route after the commands route:

```typescript
  app.route('/api/workflows', createWorkflowsRoute(ctx))
```

Add `'/api/workflows'` to the endpoints array in the root JSON response.

- [ ] **Step 4: Wire workflowRegistry in context.ts**

In `src/server/context.ts`, add the import:

```typescript
import { createAndPopulateRegistry } from '../core/workflows/index.js'
```

In `createServerContext`, after `agentRegistry` is set up, add:

```typescript
  const workflowRegistryPromise = createAndPopulateRegistry(opts.cwd ?? process.cwd())
```

Since `createServerContext` is sync, change the approach — make it async or use lazy initialization. The simplest approach that matches the existing pattern: make `workflowRegistry` lazy.

Instead, add a lazy getter pattern in the returned object:

```typescript
  let _workflowRegistry: WorkflowRegistry | undefined
  return {
    // ... existing fields ...
    get workflowRegistry() {
      if (!_workflowRegistry) {
        // 同步初始化仅含内置（discovery 是异步的，在 bootstrap 时预热）
        _workflowRegistry = createWorkflowRegistry()
        for (const wf of BUILTIN_WORKFLOWS) _workflowRegistry.register(wf)
      }
      return _workflowRegistry
    },
  }
```

Add imports for `createWorkflowRegistry` and `BUILTIN_WORKFLOWS`:

```typescript
import { BUILTIN_WORKFLOWS, createWorkflowRegistry } from '../core/workflows/index.js'
import type { WorkflowRegistry } from '../core/workflows/registry.js'
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/server/types.ts src/server/context.ts src/server/routes/workflows.ts src/server/app.ts src/server/routes/chat.ts
git commit -m "feat(workflow): wire server routes and context"
```

---

## Task 11: 前端 — WorkflowGraph phase 进度条

**Files:**
- Modify: `src/web/components/session/WorkflowGraph.tsx`
- Modify: `src/web/components/session/WorkflowGraph.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `src/web/components/session/WorkflowGraph.test.tsx`:

```typescript
  it('renders phase progress bar when phases provided', () => {
    render(
      <WorkflowGraph
        nodes={[{ id: 't0', agentType: 'coder', label: 'Task', status: 'running' }]}
        rootLabel="main"
        rootStatus="running"
        phases={['scan', 'verify', 'report']}
        currentPhase="verify"
      />,
    )
    expect(screen.getByText('scan')).toBeInTheDocument()
    expect(screen.getByText('verify')).toBeInTheDocument()
    expect(screen.getByText('report')).toBeInTheDocument()
    expect(screen.getByTestId('wf-phases')).toBeInTheDocument()
  })

  it('does not render phases bar when no phases provided', () => {
    render(
      <WorkflowGraph
        nodes={[{ id: 't0', agentType: 'coder', label: 'Task', status: 'running' }]}
        rootLabel="main"
        rootStatus="running"
      />,
    )
    expect(screen.queryByTestId('wf-phases')).toBeNull()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/web/components/session/WorkflowGraph.test.tsx`
Expected: FAIL — `phases` prop not supported

- [ ] **Step 3: Implement phases bar**

In `src/web/components/session/WorkflowGraph.tsx`, add CSS and phase component. Add after the `nodeMeta` style block:

```typescript
const phaseBar = css`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 0 8px 0;
  flex-wrap: wrap;
`

const phaseItem = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
`

const phaseItemActive = css`
  border-color: var(--primary, #4a9eff);
  color: var(--primary, #4a9eff);
  font-weight: 600;
`

const phaseItemDone = css`
  color: var(--success, #22c55e);
  border-color: var(--success, #22c55e);
`

const phaseArrow = css`
  color: var(--text-secondary);
  font-size: 11px;
`
```

Add a PhaseBar component:

```typescript
function PhaseBar({
  phases,
  currentPhase,
}: {
  phases: string[]
  currentPhase?: string
}) {
  const currentIdx = currentPhase ? phases.indexOf(currentPhase) : -1
  return (
    <div className={phaseBar} data-testid="wf-phases">
      {phases.map((phase, i) => {
        const isDone = i < currentIdx
        const isActive = phase === currentPhase
        const cls = isActive
          ? `${phaseItem} ${phaseItemActive}`
          : isDone
            ? `${phaseItem} ${phaseItemDone}`
            : phaseItem
        const icon = isDone ? '✓' : isActive ? '◐' : '○'
        return (
          <div key={phase} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span className={cls}>
              {icon} {phase}
            </span>
            {i < phases.length - 1 && <span className={phaseArrow}>→</span>}
          </div>
        )
      })}
    </div>
  )
}
```

Update the `WorkflowGraph` component signature:

```typescript
export function WorkflowGraph({
  nodes,
  rootLabel,
  rootStatus = 'completed',
  phases,
  currentPhase,
}: {
  nodes: WorkflowNode[]
  rootLabel: string
  rootStatus?: WorkflowNodeStatus
  phases?: string[]
  currentPhase?: string
}) {
  if (nodes.length === 0 && !phases) return null
```

Add the PhaseBar inside the component, after the root node and before the connector:

```typescript
      {/* Phase 进度条 */}
      {phases && phases.length > 0 && <PhaseBar phases={phases} currentPhase={currentPhase} />}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/web/components/session/WorkflowGraph.test.tsx`
Expected: PASS (all existing + 2 new tests)

- [ ] **Step 5: Commit**

```bash
git add src/web/components/session/WorkflowGraph.tsx src/web/components/session/WorkflowGraph.test.tsx
git commit -m "feat(workflow): add phase progress bar to WorkflowGraph"
```

---

## Task 12: 集成测试 — 端到端工作流执行

**Files:**
- Create: `src/core/workflows/workflow.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `src/core/workflows/workflow.integration.test.ts`:

```typescript
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { autoAllowChecker } from '../../tools/permission.js'
import { createDefaultRegistry } from '../../tools/index.js'
import { DEFAULT_CONFIG } from '../config.js'
import type { AgentDependencies } from '../types.js'
import { createAndPopulateRegistry } from './index.js'
import { executeWorkflow } from './runtime.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'wf-int-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('workflow end-to-end', () => {
  it('discovers and executes a custom .c0de/workflows/*.js workflow', async () => {
    // 写入自定义工作流
    const wfSource = `
export const meta = {
  name: 'echo-test',
  description: 'Echo test workflow',
}
export default async function workflow(ctx) {
  ctx.progress('starting echo')
  const result = await ctx.runSubagent('researcher', {
    assignment: 'just return "hello"',
    description: 'echo',
  })
  return { output: 'echo: ' + (result.ok ? result.output : result.error) }
}
`
    await mkdir(join(tmpDir, '.c0de/workflows'), { recursive: true })
    await writeFile(join(tmpDir, '.c0de/workflows', 'echo-test.js'), wfSource, 'utf-8')

    // 创建注册表
    const registry = await createAndPopulateRegistry(tmpDir)
    expect(registry.has('echo-test')).toBe(true)
    expect(registry.has('security-audit')).toBe(true) // 内置也在

    // mock deps（runSubAgent 不会被真正调用——mock ctx 的 runSubagent 不经过 runSubAgent）
    const db = await createDB({ driver: 'pglite' })
    await migrateDB(db)
    const deps: AgentDependencies = {
      db,
      llmRegistry: {} as AgentDependencies['llmRegistry'],
      toolRegistry: createDefaultRegistry(),
      permission: autoAllowChecker,
      config: DEFAULT_CONFIG,
      cwd: tmpDir,
    } as AgentDependencies

    // 注入 mock runSubAgent
    const mockParent = {
      session: { id: 'int-test', title: 'test', projectId: null },
      messages: [],
      config: { provider: 'test', model: 'test', tools: [], plugins: [], agentName: 'default' },
      status: { _tag: 'idle' },
      tools: [],
    } as unknown as Parameters<typeof executeWorkflow>[0]['parent']

    const result = await executeWorkflow({
      registry,
      name: 'echo-test',
      args: '',
      deps,
      parent: mockParent,
    })

    // 工作流会尝试调用 runSubAgent，但因为 llmRegistry 是 mock，会走到 error 分支
    // 这是预期的 — 测试验证的是工作流编排逻辑，不是 LLM 调用
    expect(result._tag).toBe('text') // 即使子 agent 失败，工作流仍返回 output
    if (result._tag === 'text') {
      expect(result.text).toContain('echo:')
    }

    await db.close()
  })

  it('builtin workflow meta is correct after population', async () => {
    const registry = await createAndPopulateRegistry(tmpDir)
    const securityAudit = registry.get('security-audit')
    expect(securityAudit).toBeDefined()
    expect(securityAudit?.source).toBe('builtin')
    expect(securityAudit?.meta.phases).toEqual(['scan', 'verify', 'report'])

    const codeReview = registry.get('code-review')
    expect(codeReview).toBeDefined()
    expect(codeReview?.meta.phases).toEqual(['review', 'merge'])
  })

  it('project workflow overrides builtin with same name', async () => {
    const overrideSource = `
export const meta = { name: 'security-audit', description: 'custom override' }
export default async function workflow(ctx) {
  return { output: 'overridden' }
}
`
    await mkdir(join(tmpDir, '.c0de/workflows'), { recursive: true })
    await writeFile(join(tmpDir, '.c0de/workflows', 'security-audit.js'), overrideSource, 'utf-8')

    const registry = await createAndPopulateRegistry(tmpDir)
    const entry = registry.get('security-audit')
    expect(entry?.source).toBe('project')
    expect(entry?.meta.description).toBe('custom override')
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `VITEST_MAX_THREADS=2 npx vitest run src/core/workflows/workflow.integration.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 3: Commit**

```bash
git add src/core/workflows/workflow.integration.test.ts
git commit -m "test(workflow): add end-to-end integration tests"
```

---

## Task 13: 运行全部测试 + 修复

- [ ] **Step 1: Run full workflow test suite**

Run: `VITEST_MAX_THREADS=2 npx vitest run src/core/workflows/`
Expected: All tests PASS

- [ ] **Step 2: Run slash test suite**

Run: `npx vitest run src/core/slash.test.ts`
Expected: PASS

- [ ] **Step 3: Run workflow (steering) tests**

Run: `npx vitest run src/core/workflow.test.ts`
Expected: PASS

- [ ] **Step 4: Run frontend tests**

Run: `npx vitest run src/web/components/session/WorkflowGraph.test.tsx`
Expected: PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `VITEST_MAX_THREADS=2 npx vitest run`
Expected: All tests PASS (or no new failures vs baseline)

- [ ] **Step 6: Run Biome lint**

Run: `npx biome check src/core/workflows/ src/server/routes/workflows.ts src/web/components/session/WorkflowGraph.tsx`
Expected: No errors (fix any formatting issues)

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix(workflow): resolve lint and test issues from full suite"
```

---

## Self-Review

### Spec coverage check

| Spec section | Task(s) | Status |
|---|---|---|
| §4.1 types.ts | Task 1 | ✓ |
| §4.2 discovery + registry | Task 2, 3, 7 | ✓ |
| §4.3 context.ts (runSubagent/utils) | Task 5 | ✓ |
| §4.4 runtime.ts | Task 6 | ✓ |
| §4.5 builtins (3 templates) | Task 4 | ✓ |
| §4.6 /workflow slash command | Task 8 | ✓ |
| §4.7 REST API routes | Task 10 | ✓ |
| §4.8 workflowz steering enhancement | Task 9 | ✓ |
| §4.9 前端 phases bar | Task 11 | ✓ |
| §5 数据流 (前台/后台执行) | Task 10 (SSE) | ✓ |
| §6 错误处理 | Task 6 (runtime), Task 3 (discovery) | ✓ |
| §7 测试策略 | All tasks (TDD) + Task 12 | ✓ |
| §8 文件清单 | All tasks | ✓ |

### Placeholder scan
- No TBD/TODO/placeholder text found
- Every step has concrete code

### Type consistency
- `WorkflowEntry` — consistent across types.ts, registry.ts, builtins.ts, discovery.ts
- `WorkflowContext` — consistent across types.ts, context.ts, runtime.ts, builtins.ts
- `WorkflowRegistry` — consistent return type from `createWorkflowRegistry` in registry.ts and import in index.ts
- `buildWorkflowContext` opts — `runSubAgentFn` for test injection matches the SubAgentResult type
- `CommandContext.workflowRegistry` — uses `WorkflowRegistry` type from workflows/registry.js
