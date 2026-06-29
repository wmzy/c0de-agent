# System Prompt Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite c0de-agent's system prompt from a thin 7-segment builder into a heavy-contract prompt (~3-3.5k tokens) that fuses the proven strengths of opencode and oh-my-pi, while fixing the hardcoded `projectInfo` bug in `loop.ts`.

**Architecture:** `buildSystemPrompt(ctx)` assembles 10 static core segments (authored as module-level `const` strings) + 4 dynamic segments (project context, tools, skills, custom-override-as-`??`). A new `detectProjectInfo(cwd)` helper reuses the existing `resolveProject` for git detection and reads `package.json` for name/framework. `config.systemPrompt` keeps its `??` whole-override semantics (callers decide override; the builder never sees custom text).

**Tech Stack:** TypeScript, Vitest, Biome, data+functions paradigm (`type` not `interface`, `_tag` discriminated unions, context-first functions).

**Reference spec:** `docs/superpowers/specs/2026-06-29-system-prompt-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/core/prompt.ts` | **Rewrite** | 10 `const` segments + `buildSystemPrompt(ctx)` assembler |
| `src/core/prompt.test.ts` | **Modify** | Update existing assertions + add coverage for new segments |
| `src/core/types.ts` | **Modify** | Extend `PromptContext` with optional `cwd?: string` |
| `src/core/types.test.ts` | **Modify** | Add `cwd` property assertion to PromptContext test |
| `src/project/detect.ts` | **Create** | `detectProjectInfo(cwd): ProjectInfo` — reuse `resolveProject` for git, read `package.json` for name/framework, infer language from extensions |
| `src/project/detect.test.ts` | **Create** | Unit tests for `detectProjectInfo` (git project, non-git fallback, no package.json) |
| `src/core/loop.ts` | **Modify** lines 80-87 | Replace hardcoded `projectInfo` with `detectProjectInfo(deps.cwd)`; pass `skills: []` |
| `src/core/index.test.ts` | **Verify** | Confirm `buildSystemPrompt` still exported (existing test, no change) |

**Note on detect location:** Placing `detectProjectInfo` in `src/project/` (alongside `resolve.ts`) co-locates project-introspection logic. It imports `resolveProject` from `./resolve.js` and the `ProjectInfo` type from `../core/types.js`.

---

## Task 1: Extend PromptContext type

**Files:**
- Modify: `src/core/types.ts:41-46`
- Test: `src/core/types.test.ts:32-35`

- [ ] **Step 1: Write the failing type test**

In `src/core/types.test.ts`, update the `PromptContext has required fields` test (around line 32) to also assert `cwd`:

```ts
  it('PromptContext has required fields', () => {
    expectTypeOf<PromptContext>().toHaveProperty('tools')
    expectTypeOf<PromptContext>().toHaveProperty('config').toEqualTypeOf<AgentConfig>()
    expectTypeOf<PromptContext>().toHaveProperty('projectInfo')
    expectTypeOf<PromptContext>().toHaveProperty('skills')
    expectTypeOf<PromptContext>().toHaveProperty('cwd')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/core/types.test.ts`
Expected: FAIL — `cwd` property does not exist on PromptContext (type-level error via `expectTypeOf`).

- [ ] **Step 3: Extend the PromptContext type**

In `src/core/types.ts`, add `cwd?: string` to `PromptContext` (currently lines 41-46):

```ts
type PromptContext = {
  tools: ToolDef[]
  config: AgentConfig
  projectInfo: ProjectInfo
  skills?: string[]
  cwd?: string
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- src/core/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/types.test.ts
git commit -m "feat(core): extend PromptContext with optional cwd field"
```

---

## Task 2: Create detectProjectInfo helper

**Files:**
- Create: `src/project/detect.ts`
- Test: `src/project/detect.test.ts`
- Reuse: `src/project/resolve.ts` (`resolveProject`)

- [ ] **Step 1: Write the failing tests**

Create `src/project/detect.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectProjectInfo } from './detect.js'

describe('detectProjectInfo', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c0de-detect-'))
  })

  afterEach(() => {
    // tmpdir 自带清理，无需手动删
  })

  it('reads name and framework from package.json', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'my-cool-app', dependencies: { react: '^19.0.0' } }),
    )
    const info = detectProjectInfo(dir)
    expect(info.name).toBe('my-cool-app')
    expect(info.framework).toBe('react')
  })

  it('infers language from .ts files', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const x = 1')
    writeFileSync(join(dir, 'src', 'b.ts'), 'export const y = 2')
    const info = detectProjectInfo(dir)
    expect(info.language).toBe('TypeScript')
  })

  it('detects git branch when in a git repo', () => {
    // 用本仓库自身作为 git repo（已是 git 仓库）
    const info = detectProjectInfo(process.cwd())
    expect(info.gitBranch).toBeTruthy()
    expect(typeof info.gitBranch).toBe('string')
  })

  it('falls back to safe defaults when package.json missing', () => {
    // dir 无 package.json、无 git
    const info = detectProjectInfo(dir)
    expect(info.name).toBe('project')
    expect(info.language).toBe('unknown')
    expect(info.framework).toBeUndefined()
    expect(info.rootDir).toBe(dir)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/project/detect.test.ts`
Expected: FAIL — `detectProjectInfo` not exported / module not found.

- [ ] **Step 3: Implement detectProjectInfo**

Create `src/project/detect.ts`:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProject } from './resolve.js'
import type { ProjectInfo } from '../core/types.js'

/** 框架推断映射：依赖名 → 框架名（按常见前端/后端框架）。 */
const FRAMEWORK_MAP: Record<string, string> = {
  react: 'react',
  'react-dom': 'react',
  vue: 'vue',
  svelte: 'svelte',
  '@angular/core': 'angular',
  next: 'next.js',
  nuxt: 'nuxt',
  '@nestjs/core': 'nest',
  '@hono/node-server': 'hono',
  hono: 'hono',
  express: 'express',
  fastify: 'fastify',
}

/** 语言推断映射：文件后缀 → 语言名。 */
const EXT_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.swift': 'Swift',
}

/** 安全读 package.json，失败返回 null。 */
function readPackageJson(cwd: string): Record<string, unknown> | null {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 从 package.json 的 deps 推断主框架。 */
function inferFramework(pkg: Record<string, unknown>): string | undefined {
  const deps = { ...(pkg.dependencies as Record<string, string>), ...(pkg.devDependencies as Record<string, string>) }
  if (!deps) return undefined
  for (const depName of Object.keys(deps)) {
    const mapped = FRAMEWORK_MAP[depName]
    if (mapped) return mapped
  }
  return undefined
}

/** 递归扫描源文件后缀统计，推断主语言（浅层，避免深扫 node_modules）。 */
function inferLanguage(cwd: string): string {
  const counts: Record<string, number> = {}
  const queue: string[] = [join(cwd, 'src')]
  let scanned = 0
  const MAX_SCAN = 500 // 防御性上限

  while (queue.length > 0 && scanned < MAX_SCAN) {
    const current = queue.shift()!
    scanned++
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry)
      let st: { isDirectory(): boolean; isFile(): boolean }
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue
        queue.push(full)
      } else if (st.isFile()) {
        const dot = entry.lastIndexOf('.')
        if (dot < 0) continue
        const ext = entry.slice(dot).toLowerCase()
        const lang = EXT_LANGUAGE_MAP[ext]
        if (lang) counts[lang] = (counts[lang] ?? 0) + 1
      }
    }
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return sorted[0]?.[0] ?? 'unknown'
}

/** 探测项目信息：name/language/framework/gitBranch，全部失败回退安全默认值。 */
function detectProjectInfo(cwd: string): ProjectInfo {
  const pkg = readPackageJson(cwd)
  const name = (pkg && typeof pkg.name === 'string' && pkg.name) || 'project'
  const framework = pkg ? inferFramework(pkg) : undefined

  let language = 'unknown'
  if (existsSync(join(cwd, 'src'))) {
    language = inferLanguage(cwd)
  } else if (pkg) {
    language = 'JavaScript'
  }

  // 复用已有 git 探测（resolveProject），不重复造轮子
  const resolved = resolveProject(cwd)
  const gitBranch = resolved.vcs === 'git' ? resolved.gitBranch : undefined

  return {
    name,
    language,
    framework,
    rootDir: cwd,
    gitBranch,
  }
}

export { detectProjectInfo }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/project/detect.test.ts`
Expected: PASS (4 tests). If the git-branch test fails because `process.cwd()` isn't a git repo, the worker is running outside the repo — switch to a `mkdtempSync` + `git init` fixture in that test instead.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors). Confirms `ProjectInfo` import resolves and `resolveProject` signature matches.

- [ ] **Step 6: Commit**

```bash
git add src/project/detect.ts src/project/detect.test.ts
git commit -m "feat(project): add detectProjectInfo reusing resolveProject for git"
```

---

## Task 3: Rewrite buildSystemPrompt with all 10 segments

**Files:**
- Modify (rewrite): `src/core/prompt.ts`
- Modify: `src/core/prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the body of `src/core/prompt.test.ts` with the expanded test suite. Keep the existing imports and `config`/`readTool` fixtures; rewrite the `describe('buildSystemPrompt')` block:

```ts
describe('buildSystemPrompt', () => {
  // 复用已有 config / readTool fixture（文件顶部已定义）

  it('includes the role description', () => {
    const prompt = buildSystemPrompt({
      tools: [readTool],
      config,
      projectInfo: { name: 'myapp', language: 'TypeScript', rootDir: '/proj' },
    })
    expect(prompt).toContain('c0de-agent')
    expect(prompt).toContain('coding assistant')
  })

  it('lists enabled tools with descriptions', () => {
    const prompt = buildSystemPrompt({
      tools: [readTool],
      config,
      projectInfo: { name: 'myapp', language: 'TypeScript', rootDir: '/proj' },
    })
    expect(prompt).toContain('read')
    expect(prompt).toContain('Read a file')
  })

  it('includes tool usage guidance preferring dedicated tools over shell commands', () => {
    const prompt = buildSystemPrompt({
      tools: [readTool],
      config,
      projectInfo: { name: 'myapp', language: 'TypeScript', rootDir: '/proj' },
    })
    expect(prompt).toContain('glob')
    expect(prompt).toMatch(/NOT.*find/i)
    expect(prompt).toMatch(/NOT.*cat/i)
    // 新增：file_path:line 引用约定
    expect(prompt).toMatch(/file_path.*line/)
  })

  it('includes project info', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'myapp', language: 'TypeScript', framework: 'React', rootDir: '/proj' },
    })
    expect(prompt).toContain('myapp')
    expect(prompt).toContain('TypeScript')
    expect(prompt).toContain('React')
  })

  it('includes paradigm constraints', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/data\s*\+\s*functions/i)
  })

  it('includes skills when provided', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
      skills: ['brainstorming'],
    })
    expect(prompt).toContain('brainstorming')
  })

  // ===== 新增段覆盖（以下为本次新增）=====

  it('includes engineering principles', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/correctness first/i)
    expect(prompt).toMatch(/allocate avoidably/i)
  })

  it('includes working-with-codebase guidance', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/package\.json/i)
    expect(prompt).toMatch(/never assume.*library/i)
  })

  it('includes execution workflow', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/execution workflow/i)
    expect(prompt).toMatch(/verify/i)
  })

  it('includes verification & evidence requirements', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/without proof/i)
    expect(prompt).toContain('[INFERENCE]')
  })

  it('includes delivery contract', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/clean cutover/i)
    expect(prompt).toMatch(/stub|placeholder|mock/i)
  })

  it('includes git safety rules', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/NEVER commit/i)
    expect(prompt).toMatch(/reset --hard/i)
  })

  it('includes tone & output guidance', () => {
    const prompt = buildSystemPrompt({
      tools: [],
      config,
      projectInfo: { name: 'x', language: 'TS', rootDir: '/' },
    })
    expect(prompt).toMatch(/concise/i)
    expect(prompt).toMatch(/preamble/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/core/prompt.test.ts`
Expected: FAIL — new assertions (`correctness first`, `package.json`, `execution workflow`, `without proof`, `clean cutover`, `NEVER commit`, `concise`) not satisfied by current prompt.

- [ ] **Step 3: Rewrite prompt.ts with all 10 segments**

Replace the entire contents of `src/core/prompt.ts`:

```ts
import type { PromptContext } from './types.js'

const ROLE_DESCRIPTION = `You are c0de-agent, an open-source AI coding assistant the team trusts with load-bearing changes. You help developers write, debug, and understand code across multiple languages and frameworks.

You operate autonomously: assume the user wants real changes and carry work through to completion end-to-end. Do not stop at analysis or partial fixes. The only times to pause and confirm are: before destructive git operations (commit, reset --hard, amend), before deleting code you did not write, and when a request is genuinely ambiguous between materially different approaches.

Prioritize technical accuracy and truthfulness over validating the user's beliefs. Investigate before confirming; disagree respectfully when necessary. Objective guidance is more valuable than false agreement.`

const ENGINEERING_PRINCIPLES = `# Engineering Principles
- Optimize for correctness first, then for the next maintainer six months out.
- You have agency and taste: delete code that isn't pulling its weight, refuse unnecessary abstractions, prefer boring when it's called for.
- Consider what code compiles to. Never allocate avoidably; no needless copies or computation.
- You are not alone in this repo. Treat unexpected changes as the user's work and adapt — never revert edits you did not make unless explicitly asked.`

const TOOL_USAGE = `# Tool Usage
You have dedicated tools — prefer them over shell commands for file operations:
- Reading a file or listing a directory → \`read\` (NOT \`cat\`, \`head\`, \`tail\`).
- Finding files by name or pattern → \`glob\` (NOT \`find\`, \`ls -R\`).
- Searching file contents → \`grep\` (NOT shell \`grep\`/\`rg\`/\`ack\`, NOT \`awk\`/\`sed\`).
- Modifying files → \`edit\`/\`write\` (NOT \`sed\`, \`echo >\`, heredocs).

Reserve \`bash\` for genuine command execution: builds, tests, git, or short pipelines that compute a fact (\`wc -l\`, \`git status\`, \`diff\`, a checksum). Never explore a codebase with \`find\`/\`ls\`/\`cat\` when \`read\`/\`glob\`/\`grep\` can.

Batch independent tool calls in a single response — parallelize file reads and independent lookups. Only sequence when one call's result informs the next.

When referencing code, use the \`file_path:line_number\` pattern so the user can navigate directly.`

const CODEBASE = `# Working with the Codebase
Before changing files, understand the existing conventions. Mimic code style, reuse existing utilities, and follow established patterns.
- NEVER assume a library is available, even if well known. Check package.json (or equivalent) and neighboring files first.
- When creating a new component, look at existing ones first for naming, typing, and framework conventions.
- When editing, read the surrounding context (especially imports) to make the change idiomatic. Never introduce code that exposes or logs secrets.`

const PARADIGM_CONSTRAINTS = `# Coding Paradigm
This project follows a strict data + functions paradigm:
- Use \`type\` (not \`interface\`) for type definitions.
- Use discriminated unions with \`_tag\` fields for variant types.
- Use plain functions \`export function foo(ctx, ...)\` with context-first argument.
- No classes; prefer factory functions and pure data transformation.
- Prefer \`import type\` for type-only imports.`

const EXECUTION_WORKFLOW = `# Execution Workflow
1. Scope — plan before touching files; research existing code and conventions.
2. Research — read sections, not snippets. Reuse existing patterns; a second convention beside an existing one is prohibited.
3. Decompose — break multi-step work into steps and track them; skip for trivial requests. Plan only what makes the request work.
4. Implement — fix problems at the source. Remove obsolete code — no leftover comments, aliases, or re-exports. Prefer editing existing files over new ones.
5. Verify — never yield non-trivial work without proof: run the relevant tests. Prefer testing behavior, not plumbing. Don't test defaults.
6. Cleanup — changelog, tests, docs, and removing scaffolding are the LAST phase, gated on the request demonstrably working. Never pre-plan cleanup before the request works.`

const VERIFICATION = `# Verification & Evidence
- Never yield non-trivial work without proof: tests, builds, or QA.
- Run lint and typecheck after changes if the project provides them.
- Every claim about code, tools, or tests must be grounded. Mark anything not directly observed as [INFERENCE].
- Verification claims must match what was actually exercised. A passing typecheck does not prove an integration.`

const DELIVERY_CONTRACT = `# Delivery Contract
- "Done" means the deliverable behaves as specified end-to-end — not that a scaffold compiles.
- Never yield unless complete. A phase boundary is never a yield point.
- Never suppress tests to make code pass. Never fabricate outputs.
- Never substitute an easier problem: don't infer extra scope, don't treat the symptom unless asked.
- Never ship stubs, placeholders, mocks, no-ops, or fake fallbacks as finished work.
- Default to clean cutover: migrate every caller; leave no shims or aliases.`

const GIT_SAFETY = `# Git & Safety
- NEVER commit unless the user explicitly asks. Committing is too proactive.
- NEVER use \`git reset --hard\` or \`git checkout --\` unless explicitly approved.
- Do not amend a commit unless asked.
- You may be in a dirty worktree. NEVER revert changes you did not make; if unrelated changes conflict with your task, stop and ask.`

const TONE = `# Tone & Output
- Be concise and direct. Lead with the conclusion, then the evidence.
- No preamble or postamble ("The answer is…", "Here is what I'll do next…").
- Use GitHub-flavored markdown. Only use emojis if explicitly asked.
- Don't hide uncertainty: state it at the specific claim, name the tradeoff.
- For a simple question, a one-liner is best.`

function buildSystemPrompt(ctx: PromptContext): string {
  const parts: string[] = []
  parts.push(ROLE_DESCRIPTION)

  if (ctx.config.systemPrompt) {
    parts.push(ctx.config.systemPrompt)
  }

  parts.push(ENGINEERING_PRINCIPLES)

  if (ctx.tools.length > 0) {
    parts.push('## Available Tools')
    for (const tool of ctx.tools) {
      parts.push(`- **${tool.name}**: ${tool.description}`)
    }
    parts.push(TOOL_USAGE)
  }

  parts.push(CODEBASE)
  parts.push(PARADIGM_CONSTRAINTS)
  parts.push(EXECUTION_WORKFLOW)
  parts.push(VERIFICATION)
  parts.push(DELIVERY_CONTRACT)
  parts.push(GIT_SAFETY)
  parts.push(TONE)

  parts.push('## Project Context')
  parts.push(`- Name: ${ctx.projectInfo.name}`)
  parts.push(`- Language: ${ctx.projectInfo.language}`)
  if (ctx.projectInfo.framework) {
    parts.push(`- Framework: ${ctx.projectInfo.framework}`)
  }
  parts.push(`- Root: ${ctx.projectInfo.rootDir}`)
  if (ctx.projectInfo.gitBranch) {
    parts.push(`- Git Branch: ${ctx.projectInfo.gitBranch}`)
  }

  if (ctx.skills && ctx.skills.length > 0) {
    parts.push('## Loaded Skills')
    for (const skill of ctx.skills) {
      parts.push(`- ${skill}`)
    }
  }

  return parts.join('\n\n')
}

export { buildSystemPrompt }
```

**Key change to note:** the old `prompt.ts` placed custom `systemPrompt` after ROLE but still rendered everything. The new version keeps `config.systemPrompt` injection inline (after ROLE) so it coexists with the contract segments. **However**, `loop.ts` still wraps the whole call in `??` (Task 4), so when `config.systemPrompt` is set, `buildSystemPrompt` is never called at all. The inline `if (ctx.config.systemPrompt)` block in `buildSystemPrompt` is therefore effectively dead for the `loop.ts` path but keeps the builder self-consistent for direct callers and the existing `includes custom systemPrompt when set` test. Keep it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/core/prompt.test.ts`
Expected: PASS (13 tests). All new segment assertions satisfied.

- [ ] **Step 5: Run lint**

Run: `pnpm lint`
Expected: PASS. If Biome flags formatting, run `pnpm format` then re-run lint.

- [ ] **Step 6: Commit**

```bash
git add src/core/prompt.ts src/core/prompt.test.ts
git commit -m "feat(core): rewrite buildSystemPrompt with heavy-contract segments"
```

---

## Task 4: Fix loop.ts hardcoded projectInfo and wire skills

**Files:**
- Modify: `src/core/loop.ts:14` (add import), `src/core/loop.ts:80-87` (replace hardcoded block)

- [ ] **Step 1: Add the detectProjectInfo import**

In `src/core/loop.ts`, add the import near the other relative imports (after the `buildSystemPrompt` import around line 14):

```ts
import { detectProjectInfo } from '../project/detect.js'
```

- [ ] **Step 2: Replace the hardcoded projectInfo block**

In `src/core/loop.ts`, replace lines 80-87 (the current block):

```ts
    const systemPrompt =
      state.config.systemPrompt ??
      buildSystemPrompt({
        tools: state.tools,
        config: state.config,
        projectInfo: {
          name: 'project',
          language: 'TypeScript',
          rootDir: deps.cwd,
        },
      })
```

with:

```ts
    const systemPrompt =
      state.config.systemPrompt ??
      buildSystemPrompt({
        tools: state.tools,
        config: state.config,
        projectInfo: detectProjectInfo(deps.cwd),
        skills: [],
      })
```

**Note:** `skills: []` is a placeholder — c0de-agent has no skills system yet (no skills files exist in `src/`). When a skills system is added later, replace `[]` with the resolved skill list. The design spec documents this as intentional.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS. Confirms `detectProjectInfo` import resolves and return type `ProjectInfo` is assignable to the `buildSystemPrompt` `projectInfo` parameter.

- [ ] **Step 4: Run the full core test suite**

Run: `pnpm test -- src/core/`
Expected: PASS. The existing `index.test.ts` (export check), `types.test.ts`, and `prompt.test.ts` all pass. No loop.ts behavioral test exercises the prompt path directly (the loop is async-generator, tested via integration), so this confirms no type/import regressions.

- [ ] **Step 5: Commit**

```bash
git add src/core/loop.ts
git commit -m "fix(core): use detectProjectInfo instead of hardcoded projectInfo in loop"
```

---

## Task 5: Verify token budget and run full test suite

**Files:**
- Verify only (no edits unless budget exceeded)

- [ ] **Step 1: Verify token estimate is within budget**

Run this one-liner to estimate the rendered prompt's token count using the project's own CJK-aware estimator:

```bash
node --input-type=module -e "
import { buildSystemPrompt } from './src/core/prompt.js';
import { estimateTokens } from './src/session/token.js';
const prompt = buildSystemPrompt({
  tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} }, permission: 'auto', execute: async () => ({ _tag: 'success', output: '' }) }],
  config: { provider: 'openai', model: 'gpt-4o', tools: ['read'], plugins: [] },
  projectInfo: { name: 'c0de-agent', language: 'TypeScript', rootDir: process.cwd() },
});
const tokens = estimateTokens(prompt);
console.log('tokens:', tokens, 'chars:', prompt.length);
console.log('in budget (3-3.5k):', tokens >= 2500 && tokens <= 4000);
"
```

Expected: tokens between ~2500-4000. The design targets 3-3.5k; this confirms it. If the count is wildly off (e.g. >5000), a segment is too verbose — trim the longest `const` block and re-run.

**If `node --input-type=module` fails on ESM resolution:** instead run via the project's tsx loader:

```bash
pnpm exec tsx -e "
import { buildSystemPrompt } from './src/core/prompt.js';
import { estimateTokens } from './src/session/token.js';
const prompt = buildSystemPrompt({
  tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} }, permission: 'auto', execute: async () => ({ _tag: 'success', output: '' }) }],
  config: { provider: 'openai', model: 'gpt-4o', tools: ['read'], plugins: [] },
  projectInfo: { name: 'c0de-agent', language: 'TypeScript', rootDir: process.cwd() },
});
console.log('tokens:', estimateTokens(prompt), 'chars:', prompt.length);
"
```

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all test files green. Pay attention to `src/core/` and `src/project/` (newly touched) and `src/server/routes/project.test.ts` (uses `resolveProject`, unaffected but confirm).

- [ ] **Step 3: Run typecheck across the project**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Run lint across the project**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit (if any formatting fixes)**

If Steps 2-4 needed no edits, skip. If `pnpm format` changed anything:

```bash
git add -A
git commit -m "style: apply biome formatting to prompt overhaul"
```

---

## Self-Review Notes

- **Spec coverage:** Spec §4.1 segments 1-10 → Task 3 (all 10 `const` blocks). Spec §4.2 segments 11-14 → Task 3 (`buildSystemPrompt` assembler) + Task 4 (loop wiring). Spec §5.1 prompt.ts rewrite → Task 3. Spec §5.2 detectProjectInfo → Task 2. Spec §5.3 PromptContext cwd → Task 1. Spec §5.4 test updates → Tasks 1 & 3. Acceptance #1-5 all have tasks.
- **Type consistency:** `ProjectInfo` type used identically in `detect.ts` (returns it), `types.ts` (defines it), `prompt.ts` (consumes `ctx.projectInfo`). `resolveProject` return type `ResolvedProject` has `gitBranch: string | null`; `detectProjectInfo` maps non-git to `undefined` via the `vcs === 'git'` guard. `buildSystemPrompt` signature unchanged (`(ctx: PromptContext) => string`).
- **No placeholders:** Every code step contains complete code; every run step contains the exact command and expected outcome.
