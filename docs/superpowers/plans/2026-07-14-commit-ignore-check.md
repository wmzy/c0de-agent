# 提交前 LLM 忽略检查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在一键提交前用 LLM 检查 diff 中是否有该被忽略却漏加 `.gitignore` 的文件，检测到则阻断提交、弹框让用户选择（加入 .gitignore / 强制提交 / 取消）。

**Architecture:** 复用生成 commit message 的单次 LLM 调用，改造 prompt 为 JSON 输出（message + ignoreSuggestions）。默认模式执行检查；force 模式跳过检查直接提交；append-ignore 模式追加 .gitignore 后提交。JSON 解析失败则 fail-closed 报错阻断。

**Tech Stack:** Hono（后端路由）、React + linaria + @tanstack/react-query（前端）、vitest（测试）、PGLite（测试数据库）

---

## File Structure

| 文件 | 改动 | 职责 |
|---|---|---|
| `src/project/resolve.ts` | Modify | 新增 `appendToGitignore()` |
| `src/project/resolve.test.ts` | Modify | 为 `appendToGitignore` 添加测试 |
| `src/server/routes/files.ts` | Modify | 重写 `/git-commit` 路由（prompt + JSON + mode 分支） |
| `src/server/routes/files.test.ts` | Modify | 重构 mock 支持 per-test override，新增路由测试 |
| `src/web/types/index.ts` | Modify | 新增 `CommitResponse` 联合类型 |
| `src/web/services/file.ts` | Modify | `gitCommit` 支持可选 body 参数 |
| `src/web/components/CommitReviewDialog.tsx` | Create | 可疑文件确认弹框（三选项） |
| `src/web/components/CommitButton.tsx` | Modify | 集成弹框，处理 needsReview 响应 |
| `src/web/components/TopBar.test.tsx` | Modify | 新增 needsReview 交互测试 |

---

### Task 1: `appendToGitignore` 函数

**Files:**
- Modify: `src/project/resolve.ts`（新增函数 + 更新 import）
- Test: `src/project/resolve.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/project/resolve.test.ts` 的 `describe('checkIgnored', ...)` 之后追加新 describe block：

```ts
describe('appendToGitignore', () => {
  it.runIf(hasGit)('追加新条目到已有 .gitignore', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-appendgi-'))
    execSync('git init -q', { cwd: repo })
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n*.log\n')

    appendToGitignore(repo, ['.env', 'dist/'])

    const content = readFileSync(join(repo, '.gitignore'), 'utf-8')
    expect(content).toContain('node_modules')
    expect(content).toContain('.env')
    expect(content).toContain('dist/')
  })

  it.runIf(hasGit)('跳过已存在的条目（去重）', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-appendgi-dedup-'))
    execSync('git init -q', { cwd: repo })
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n*.log\n')

    appendToGitignore(repo, ['node_modules', '.env'])

    const content = readFileSync(join(repo, '.gitignore'), 'utf-8')
    // node_modules 只出现一次
    expect(content.match(/node_modules/g)?.length).toBe(1)
    expect(content).toContain('.env')
  })

  it.runIf(hasGit)('.gitignore 不存在时创建新文件', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-appendgi-new-'))
    execSync('git init -q', { cwd: repo })

    appendToGitignore(repo, ['.env', 'dist/'])

    const content = readFileSync(join(repo, '.gitignore'), 'utf-8')
    expect(content).toContain('.env')
    expect(content).toContain('dist/')
  })

  it.runIf(hasGit)('所有条目都已存在时不修改文件', () => {
    const repo = mkdtempSync(join(tmpdir(), 'c0de-appendgi-noop-'))
    execSync('git init -q', { cwd: repo })
    const original = 'node_modules\n*.log\n'
    writeFileSync(join(repo, '.gitignore'), original)

    appendToGitignore(repo, ['node_modules', '*.log'])

    const content = readFileSync(join(repo, '.gitignore'), 'utf-8')
    expect(content).toBe(original)
  })
})
```

在文件顶部 import 区域追加 `appendToGitignore`（与已有的 `checkIgnored` 同行）：

```ts
import { appendToGitignore, checkIgnored, getGitLastCommit, resolveProject } from './resolve.js'
```

还需要确保 `readFileSync` 已在 import 中（检查文件头部，已有 `writeFileSync` 等同步 fs API 的 import）。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/project/resolve.test.ts -t appendToGitignore`
Expected: FAIL — `appendToGitignore is not defined`

- [ ] **Step 3: 实现函数**

在 `src/project/resolve.ts` 的 import 区域，将第一行改为：

```ts
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
```

在 `checkIgnored` 函数之后（`getGitBranch` 之前）追加：

```ts
/** 追加条目到 .gitignore（去重，文件不存在则创建）。 */
export function appendToGitignore(cwd: string, patterns: string[]): void {
  const gitignorePath = join(cwd, '.gitignore')
  let existing = ''
  try {
    existing = readFileSync(gitignorePath, 'utf-8')
  } catch {
    // 文件不存在，视为空
  }
  const existingLines = new Set(
    existing
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  )
  const toAppend = patterns
    .map((p) => p.trim())
    .filter((p) => p && !existingLines.has(p))
  if (toAppend.length === 0) return
  const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
  writeFileSync(gitignorePath, existing + prefix + toAppend.join('\n') + '\n')
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run src/project/resolve.test.ts -t appendToGitignore`
Expected: PASS — 4 tests passed

- [ ] **Step 5: Commit**

```bash
git add src/project/resolve.ts src/project/resolve.test.ts
git commit -m "feat: add appendToGitignore function"
```

---

### Task 2: 重构路由测试 mock 支持 per-test override

**Files:**
- Modify: `src/server/routes/files.test.ts`（mock 区域，约第 12-20 行）

此任务将固定的 mock 返回值改为 `vi.hoisted` 可变变量，使后续测试能 per-test 覆盖。同时更新默认值为 JSON 格式（适配新 prompt）。

- [ ] **Step 1: 替换 mock 为 vi.hoisted 模式**

将 `src/server/routes/files.test.ts` 第 12-20 行的 mock：

```ts
// mock createSummarizer 以避免真实 LLM 调用；保留 runCompaction 等其他导出
vi.mock('../../core/compact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/compact.js')>()
  return {
    ...actual,
    createSummarizer: () => async () => 'feat: auto-generated commit message',
  }
})
```

替换为：

```ts
// mock createSummarizer 以避免真实 LLM 调用；保留 runCompaction 等其他导出
// 使用 vi.hoisted 以便 per-test 覆盖 LLM 返回值（不同测试需要不同的 JSON 响应）
const { mockLLMResponse } = vi.hoisted(() => ({
  mockLLMResponse: {
    value: '{"message":"feat: auto-generated commit message","ignoreSuggestions":[]}',
  },
}))
vi.mock('../../core/compact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/compact.js')>()
  return {
    ...actual,
    createSummarizer: () => async () => mockLLMResponse.value,
  }
})
```

- [ ] **Step 2: 运行已有测试确认不破坏**

Run: `npx vitest run src/server/routes/files.test.ts`
Expected: PASS — 所有现有测试通过（mock 默认返回有效 JSON，message 字段解析后仍为 `'feat: auto-generated commit message'`）

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/files.test.ts
git commit -m "refactor: make commit mock overridable via vi.hoisted"
```

---

### Task 3: 路由测试 — 默认模式（committed + needsReview + parse error）

**Files:**
- Modify: `src/server/routes/files.test.ts`（`describe('git-commit route')` 内追加用例）

- [ ] **Step 1: 更新已有「有变更时提交」测试**

找到 `it('POST /git-commit 有变更时用 LLM 生成 message 并提交')` 测试。此测试的断言不需要改（`body.message` 仍为 `'feat: auto-generated commit message'`），但需要在测试开头重置 mock 值以防其他测试的 override 泄漏。

在该 `it(...)` 的第一行（`const dir = ...` 之前）加：

```ts
    mockLLMResponse.value =
      '{"message":"feat: auto-generated commit message","ignoreSuggestions":[]}'
```

- [ ] **Step 2: 添加 needsReview 测试**

在 `describe('git-commit route')` 末尾（最后一个 `it` 之后、`})` 闭合之前）追加：

```ts
  it('POST /git-commit LLM 检测到可疑文件时返回 needsReview', async () => {
    mockLLMResponse.value =
      '{"message":"feat: add config","ignoreSuggestions":[".env","dist/"]}'

    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-review-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, 'base.txt'), 'base')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    writeFileSync(join(dir, 'new-file.ts'), 'export const x = 1')

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      needsReview?: boolean
      message?: string
      suggestions?: string[]
    }
    expect(body.needsReview).toBe(true)
    expect(body.message).toBe('feat: add config')
    expect(body.suggestions).toEqual(['.env', 'dist/'])
    // 没有实际提交
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' })
    expect(status.trim()).not.toBe('')
  })
```

- [ ] **Step 3: 添加 JSON 解析失败测试**

继续追加：

```ts
  it('POST /git-commit LLM 返回无法解析的响应时返回 502', async () => {
    mockLLMResponse.value = 'This is not valid JSON at all'

    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-parseerr-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, 'base.txt'), 'base')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    writeFileSync(join(dir, 'new-file.ts'), 'export const x = 1')

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', { method: 'POST' })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('CHECK_PARSE_ERROR')
    // 没有实际提交
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' })
    expect(status.trim()).not.toBe('')
  })
```

- [ ] **Step 4: 运行测试验证失败（路由尚未实现）**

Run: `npx vitest run src/server/routes/files.test.ts -t "git-commit route"`
Expected: FAIL — needsReview 和 parse error 测试失败（当前路由仍返回 committed: true）

- [ ] **Step 5: Commit（测试先行，尚未实现）**

```bash
git add src/server/routes/files.test.ts
git commit -m "test: add commit ignore check route tests (red)"
```

---

### Task 4: 路由测试 — force / append-ignore 模式

**Files:**
- Modify: `src/server/routes/files.test.ts`（继续在 `describe('git-commit route')` 追加）

- [ ] **Step 1: 添加 force 模式测试**

在 `describe('git-commit route')` 末尾追加：

```ts
  it('POST /git-commit mode=force 跳过检查直接提交', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-force-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, 'base.txt'), 'base')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    writeFileSync(join(dir, 'new-file.ts'), 'export const x = 1')

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'force', message: 'feat: force commit' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { committed: boolean; message: string }
    expect(body.committed).toBe(true)
    expect(body.message).toBe('feat: force commit')
    const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf-8' })
    expect(log).toContain('feat: force commit')
  })
```

- [ ] **Step 2: 添加 append-ignore 模式测试**

继续追加：

```ts
  it('POST /git-commit mode=append-ignore 追加 .gitignore 后提交', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-appendignore-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    writeFileSync(join(dir, 'base.txt'), 'base')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    writeFileSync(join(dir, 'new-file.ts'), 'export const x = 1')

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'append-ignore',
        message: 'feat: add feature',
        suggestions: ['.env', 'dist/'],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { committed: boolean; message: string }
    expect(body.committed).toBe(true)
    expect(body.message).toBe('feat: add feature')
    // .gitignore 被追加了新条目
    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.env')
    expect(gitignore).toContain('dist/')
    expect(gitignore).toContain('node_modules')
    // git log 包含提交
    const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf-8' })
    expect(log).toContain('feat: add feature')
  })
```

确保 `readFileSync` 已在文件头部 import（检查已有 import，文件第 2 行有 `readFileSync`，如果没有则添加）。

- [ ] **Step 3: 添加缺少 message 的错误测试**

继续追加：

```ts
  it('POST /git-commit mode=force 缺少 message 返回 400', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c0de-commit-nomsg-'))
    const { execSync } = await import('node:child_process')
    execSync('git init -q', { cwd: dir })
    execSync('git config user.email test@test.com', { cwd: dir })
    execSync('git config user.name test', { cwd: dir })
    writeFileSync(join(dir, 'f.txt'), 'x')
    execSync('git add -A && git commit -q -m init', { cwd: dir })
    writeFileSync(join(dir, 'f.txt'), 'changed')

    const db = await createDB({ driver: 'pglite' })
    dbHandle = db
    await migrateDB(db)
    const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd: dir })
    const app = createFilesRoute(ctx)

    const res = await app.request('/git-commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'force' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('MISSING_MESSAGE')
  })
```

- [ ] **Step 4: 运行测试验证失败**

Run: `npx vitest run src/server/routes/files.test.ts -t "git-commit route"`
Expected: FAIL — force/append-ignore 测试失败（路由尚未支持 mode 参数）

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/files.test.ts
git commit -m "test: add force and append-ignore mode route tests (red)"
```

---

### Task 5: 路由实现

**Files:**
- Modify: `src/server/routes/files.ts`（import 区 + `/git-commit` 路由，约第 133-172 行）

- [ ] **Step 1: 添加 import**

在 `src/server/routes/files.ts` 第 5-13 行的 import block 中，将 `appendToGitignore` 加入从 `../../project/resolve.js` 的 import：

```ts
import {
  appendToGitignore,
  checkIgnored,
  checkoutGitBranch,
  createGitBranch,
  getGitBranch,
  getGitDiffSummary,
  getGitLastCommit,
  getGitStatus,
  listGitBranches,
  performGitCommit,
} from '../../project/resolve.js'
```

- [ ] **Step 2: 重写 `/git-commit` 路由**

将 `src/server/routes/files.ts` 中整个 `app.post('/git-commit', ...)` 替换为：

```ts
  // 一键提交：用 LLM 生成 commit message + 检查可疑文件，支持 force/append-ignore 模式
  app.post('/git-commit', async (c) => {
    const projectId = c.req.query('projectId')
    let root = ctx.cwd
    if (projectId) {
      const project = await getProject(ctx.db, projectId)
      if (!project) {
        return apiError(c, 404, 'NOT_FOUND', 'Project not found')
      }
      root = project.worktree
    }
    const summary = getGitDiffSummary(root)
    if (!summary) {
      return apiError(c, 400, 'NO_CHANGES', 'No changes to commit')
    }

    // 可选 body：mode / message / suggestions
    const body = await c.req.json().catch(
      () => ({}) as { mode?: string; message?: string; suggestions?: string[] },
    )

    // --- mode: force — 跳过检查，用传入 message 直接提交 ---
    if (body.mode === 'force') {
      if (!body.message) {
        return apiError(c, 400, 'MISSING_MESSAGE', 'mode=force requires a message')
      }
      const result = performGitCommit(root, body.message)
      if ('error' in result) {
        return apiError(c, 500, 'COMMIT_FAILED', result.error)
      }
      return c.json({
        committed: true,
        message: body.message,
        hash: result.hash,
        fileCount: summary.fileCount,
      })
    }

    // --- mode: append-ignore — 追加 .gitignore 后提交 ---
    if (body.mode === 'append-ignore') {
      if (!body.message) {
        return apiError(c, 400, 'MISSING_MESSAGE', 'mode=append-ignore requires a message')
      }
      if (!body.suggestions || body.suggestions.length === 0) {
        return apiError(c, 400, 'MISSING_SUGGESTIONS', 'mode=append-ignore requires suggestions')
      }
      appendToGitignore(root, body.suggestions)
      const result = performGitCommit(root, body.message)
      if ('error' in result) {
        return apiError(c, 500, 'COMMIT_FAILED', result.error)
      }
      return c.json({
        committed: true,
        message: body.message,
        hash: result.hash,
        fileCount: summary.fileCount,
      })
    }

    // --- 默认模式：LLM 生成 message + 检查可疑文件 ---
    const cm = ctx.config.commitModel
    const provider = cm?.provider ?? ctx.config.defaultProvider
    const model = cm?.model ?? ctx.config.defaultModel
    const prompt = `Based on the following git diff, generate a concise commit message in conventional-commits format (e.g. "feat: add login page").

ALSO review the changed/new files: are any of them files that SHOULD be in .gitignore but are currently missing? (e.g. secrets, .env, build output, dependencies, temp files, large binaries)

Reply as JSON ONLY:
{"message": "<commit message>", "ignoreSuggestions": ["<path>", ...]}

If no files need ignoring, return an empty array for ignoreSuggestions.

${summary.diff.slice(0, 8000)}`

    let raw: string
    try {
      const summarizer = createSummarizer(ctx.llmRegistry, provider, model, { maxTokens: 400 })
      raw = (await summarizer(prompt)).trim()
    } catch (err) {
      return apiError(c, 502, 'LLM_ERROR', `Failed to generate commit message: ${String(err)}`)
    }
    // LLM 返回可能含 markdown 代码块包裹，去掉
    raw = raw
      .replace(/^```[a-z]*\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim()

    // JSON 解析（fail-closed：无法解析 → 报错阻断，不提交）
    let parsed: { message?: string; ignoreSuggestions?: string[] }
    try {
      parsed = JSON.parse(raw)
    } catch {
      return apiError(
        c,
        502,
        'CHECK_PARSE_ERROR',
        'Commit ignore check failed: LLM returned unparseable response',
      )
    }

    const message = (parsed.message ?? '').trim()
    if (!message) {
      return apiError(c, 502, 'EMPTY_MESSAGE', 'LLM returned empty commit message')
    }

    const suggestions = Array.isArray(parsed.ignoreSuggestions) ? parsed.ignoreSuggestions : []

    // LLM 检测到可疑文件 → 阻断提交，返回供前端审查
    if (suggestions.length > 0) {
      return c.json({ needsReview: true, message, suggestions })
    }

    // 无可疑文件 → 直接提交
    const result = performGitCommit(root, message)
    if ('error' in result) {
      return apiError(c, 500, 'COMMIT_FAILED', result.error)
    }
    return c.json({
      committed: true,
      message,
      hash: result.hash,
      fileCount: summary.fileCount,
    })
  })
```

- [ ] **Step 3: 运行全部路由测试验证通过**

Run: `npx vitest run src/server/routes/files.test.ts`
Expected: PASS — 所有测试通过（包括新增的 needsReview、parse error、force、append-ignore 测试）

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/files.ts
git commit -m "feat: commit ignore check with LLM, force/append-ignore modes"
```

---

### Task 6: 前端类型 + API 层

**Files:**
- Modify: `src/web/types/index.ts`
- Modify: `src/web/services/file.ts`

- [ ] **Step 1: 添加 CommitResponse 类型**

在 `src/web/types/index.ts` 的 `FileContent` 类型之后追加：

```ts
/** 一键提交响应：提交成功或需要审查（检测到可疑文件）。 */
type CommitResponse =
  | { committed: true; message: string; hash: string; fileCount: number }
  | { needsReview: true; message: string; suggestions: string[] }
```

在文件底部的 export 块（约第 99-110 行）追加 `CommitResponse`：

```ts
  CodeReference,
  CommitResponse,
  FileContent,
  FileEntry,
```

- [ ] **Step 2: 更新 gitCommit API 方法**

在 `src/web/services/file.ts` 的 import 区域添加 `CommitResponse`：

```ts
import type { CommitResponse, FileContent, FileEntry, FileSearchResult, GitStatusMap } from '../types/index.js'
```

将 `gitCommit` 方法从：

```ts
  gitCommit: (projectId?: string) =>
    apiRequest<{ committed: boolean; message: string; hash: string; fileCount: number }>(
      `/api/files/git-commit${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'POST' },
    ),
```

改为：

```ts
  gitCommit: (
    projectId?: string,
    body?: { mode?: string; message?: string; suggestions?: string[] },
  ) =>
    apiRequest<CommitResponse>(
      `/api/files/git-commit${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'POST', body: body ? JSON.stringify(body) : undefined },
    ),
```

- [ ] **Step 3: 验证前端编译通过**

Run: `npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add src/web/types/index.ts src/web/services/file.ts
git commit -m "feat: add CommitResponse type and update gitCommit API"
```

---

### Task 7: CommitReviewDialog 组件

**Files:**
- Create: `src/web/components/CommitReviewDialog.tsx`
- Test: `src/web/components/CommitReviewDialog.test.tsx`

- [ ] **Step 1: 创建组件**

创建 `src/web/components/CommitReviewDialog.tsx`：

```tsx
import { css } from '@linaria/core'

const overlay = css`
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 50%);
`

const card = css`
  min-width: 340px;
  max-width: 460px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: 0 8px 24px rgb(0 0 0 / 20%);
`

const title = css`
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 8px;
`

const body = css`
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
  margin-bottom: 12px;
`

const fileList = css`
  margin: 4px 0 12px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-radius: 4px;
  font-size: 12px;
  font-family: var(--font-mono, monospace);
  color: var(--text-secondary);
`

const actions = css`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
`

const btn = css`
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;

  &:hover {
    background: var(--bg);
  }
`

const primary = css`
  ${btn};
  border-color: var(--warning, var(--border));
  background: var(--warning, var(--bg-secondary));
  color: #fff;
`

/**
 * 提交前可疑文件确认弹框。LLM 检测到应忽略的文件后弹出，
 * 三选项：加入 .gitignore 再提交 / 仍然提交 / 取消。
 */
export function CommitReviewDialog({
  suggestions,
  message,
  onAppendIgnore,
  onForce,
  onCancel,
}: {
  suggestions: string[]
  message: string
  onAppendIgnore: () => void
  onForce: () => void
  onCancel: () => void
}) {
  return (
    <div className={overlay} data-testid="commit-review-dialog" role="dialog" aria-modal="true">
      <div className={card}>
        <div className={title}>检测到可能需要忽略的文件</div>
        <div className={body}>
          AI 检查变更内容后认为以下文件可能应该加入 .gitignore：
        </div>
        <div className={fileList}>
          {suggestions.map((s) => (
            <div key={s}>{s}</div>
          ))}
        </div>
        <div className={actions}>
          <button
            type="button"
            className={btn}
            onClick={onCancel}
            data-testid="commit-review-cancel"
          >
            取消
          </button>
          <button
            type="button"
            className={btn}
            onClick={onForce}
            data-testid="commit-review-force"
          >
            仍然提交
          </button>
          <button
            type="button"
            className={primary}
            onClick={onAppendIgnore}
            data-testid="commit-review-ignore"
          >
            加入 .gitignore 再提交
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 写组件测试**

创建 `src/web/components/CommitReviewDialog.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommitReviewDialog } from './CommitReviewDialog.js'

afterEach(cleanup)

describe('CommitReviewDialog', () => {
  it('渲染所有可疑文件', () => {
    render(
      <CommitReviewDialog
        suggestions={['.env', 'dist/']}
        message="feat: x"
        onAppendIgnore={vi.fn()}
        onForce={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('.env')).toBeInTheDocument()
    expect(screen.getByText('dist/')).toBeInTheDocument()
  })

  it('点击「加入 .gitignore 再提交」调用 onAppendIgnore', () => {
    const onAppendIgnore = vi.fn()
    render(
      <CommitReviewDialog
        suggestions={['.env']}
        message="feat: x"
        onAppendIgnore={onAppendIgnore}
        onForce={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('commit-review-ignore'))
    expect(onAppendIgnore).toHaveBeenCalledOnce()
  })

  it('点击「仍然提交」调用 onForce', () => {
    const onForce = vi.fn()
    render(
      <CommitReviewDialog
        suggestions={['.env']}
        message="feat: x"
        onAppendIgnore={vi.fn()}
        onForce={onForce}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('commit-review-force'))
    expect(onForce).toHaveBeenCalledOnce()
  })

  it('点击「取消」调用 onCancel', () => {
    const onCancel = vi.fn()
    render(
      <CommitReviewDialog
        suggestions={['.env']}
        message="feat: x"
        onAppendIgnore={vi.fn()}
        onForce={vi.fn()}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('commit-review-cancel'))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 3: 运行测试验证通过**

Run: `npx vitest run src/web/components/CommitReviewDialog.test.tsx`
Expected: PASS — 4 tests passed

- [ ] **Step 4: Commit**

```bash
git add src/web/components/CommitReviewDialog.tsx src/web/components/CommitReviewDialog.test.tsx
git commit -m "feat: add CommitReviewDialog component"
```

---

### Task 8: CommitButton 集成弹框

**Files:**
- Modify: `src/web/components/CommitButton.tsx`
- Modify: `src/web/components/TopBar.test.tsx`

- [ ] **Step 1: 更新 CommitButton 处理 needsReview 响应**

在 `src/web/components/CommitButton.tsx` 的 import 区追加：

```tsx
import { CommitReviewDialog } from './CommitReviewDialog.js'
```

将 `CommitButton` 组件的 mutation 和 state 部分（从 `const [commitFeedback, ...]` 到 `onClick` 之前）替换为：

```tsx
  const [commitFeedback, setCommitFeedback] = useState<
    { kind: 'idle' } | { kind: 'ok'; message: string } | { kind: 'err'; msg: string }
  >({ kind: 'idle' })

  // LLM 检测到可疑文件时展示审查弹框
  const [reviewState, setReviewState] = useState<{
    message: string
    suggestions: string[]
  } | null>(null)

  const commitMut = useMutation({
    mutationFn: (body?: { mode?: string; message?: string; suggestions?: string[] }) =>
      fileAPI.gitCommit(projectId, body),
    onMutate: () => setCommitFeedback({ kind: 'idle' }),
    onSuccess: (data) => {
      // 需要审查 → 弹框，不显示成功
      if ('needsReview' in data && data.needsReview) {
        setReviewState({ message: data.message, suggestions: data.suggestions })
        return
      }
      // 提交成功 → 关弹框（若有）、显示成功、刷新状态
      setReviewState(null)
      setCommitFeedback({ kind: 'ok', message: data.message })
      queryClient.invalidateQueries({ queryKey: ['files', 'git-status', projectId] })
      setTimeout(() => setCommitFeedback((s) => (s.kind === 'ok' ? { kind: 'idle' } : s)), 3000)
    },
    onError: (err: unknown) => {
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: string }).message)
          : '提交失败'
      setCommitFeedback({ kind: 'err', msg })
      setTimeout(() => setCommitFeedback((s) => (s.kind === 'err' ? { kind: 'idle' } : s)), 5000)
    },
  })
```

将 `return (...)` 部分的 JSX 替换为（在 button 之后加 dialog）：

```tsx
  return (
    <>
      <button
        type="button"
        className={btnClass}
        onClick={() => commitMut.mutate()}
        disabled={commitMut.isPending || !hasChanges}
        title={title}
        data-testid="git-commit-btn"
        data-has-changes={hasChanges || undefined}
      >
        {label}
      </button>
      {reviewState && (
        <CommitReviewDialog
          suggestions={reviewState.suggestions}
          message={reviewState.message}
          onAppendIgnore={() =>
            commitMut.mutate({
              mode: 'append-ignore',
              message: reviewState.message,
              suggestions: reviewState.suggestions,
            })
          }
          onForce={() => commitMut.mutate({ mode: 'force', message: reviewState.message })}
          onCancel={() => setReviewState(null)}
        />
      )}
    </>
  )
```

注意：原来的 `return ( <button ...> )` 变成了 `return ( <> <button ...> {dialog} </> )`。

- [ ] **Step 2: 更新 TopBar 测试 mock 签名**

在 `src/web/components/TopBar.test.tsx` 中，找到已有的 commit 按钮测试 `'点击提交按钮调用 gitCommit API'`。该测试 mock 了 `gitCommit` 返回 `{ committed: true, ... }`，不需要修改——因为它没有传 body 参数，`gitCommit('p1')` 的 mock 仍会被调用。

但 mock 的 `toHaveBeenCalledWith` 断言需要确认。找到：

```ts
    expect(fileAPI.gitCommit).toHaveBeenCalledWith('p1')
```

这仍然有效（第一次调用时 body 为 `undefined`）。无需修改。

- [ ] **Step 3: 添加 needsReview 交互测试**

在 `src/web/components/TopBar.test.tsx` 的 `describe('TopBar')` 末尾，最后一个 `it` 之后追加：

```ts
  it('LLM 检测到可疑文件时弹审查框，选「仍然提交」后调用 force 模式', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    // 第一次调用返回 needsReview
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        needsReview: true,
        message: 'feat: add config',
        suggestions: ['.env'],
      })
      .mockResolvedValueOnce({
        committed: true,
        message: 'feat: add config',
        hash: 'abc123',
        fileCount: 2,
      })

    renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').getAttribute('data-has-changes')).toBe('true')
    })

    fireEvent.click(screen.getByTestId('git-commit-btn'))

    // 弹出审查框
    await waitFor(() => {
      expect(screen.getByTestId('commit-review-dialog')).toBeInTheDocument()
    })
    expect(screen.getByText('.env')).toBeInTheDocument()

    // 选「仍然提交」
    fireEvent.click(screen.getByTestId('commit-review-force'))

    // 第二次调用使用 force 模式
    await waitFor(() => {
      expect(fileAPI.gitCommit).toHaveBeenNthCalledWith(2, 'p1', {
        mode: 'force',
        message: 'feat: add config',
      })
    })
    // 弹框关闭，显示成功
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').textContent).toContain('已提交')
    })
  })

  it('LLM 检测到可疑文件时选「加入 .gitignore」调用 append-ignore 模式', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        needsReview: true,
        message: 'feat: add feature',
        suggestions: ['.env', 'dist/'],
      })
      .mockResolvedValueOnce({
        committed: true,
        message: 'feat: add feature',
        hash: 'def456',
        fileCount: 3,
      })

    renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').getAttribute('data-has-changes')).toBe('true')
    })

    fireEvent.click(screen.getByTestId('git-commit-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('commit-review-dialog')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('commit-review-ignore'))

    await waitFor(() => {
      expect(fileAPI.gitCommit).toHaveBeenNthCalledWith(2, 'p1', {
        mode: 'append-ignore',
        message: 'feat: add feature',
        suggestions: ['.env', 'dist/'],
      })
    })
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').textContent).toContain('已提交')
    })
  })

  it('审查框选「取消」关闭弹框不提交', async () => {
    const { fileAPI } = await import('../services/file.js')
    ;(fileAPI.gitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      'foo.ts': 'modified',
    })
    ;(fileAPI.gitCommit as ReturnType<typeof vi.fn>).mockResolvedValue({
      needsReview: true,
      message: 'feat: x',
      suggestions: ['.env'],
    })

    renderAtProject('p1')
    await waitFor(() => {
      expect(screen.getByTestId('git-commit-btn').getAttribute('data-has-changes')).toBe('true')
    })

    fireEvent.click(screen.getByTestId('git-commit-btn'))

    await waitFor(() => {
      expect(screen.getByTestId('commit-review-dialog')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('commit-review-cancel'))

    // 弹框消失
    await waitFor(() => {
      expect(screen.queryByTestId('commit-review-dialog')).toBeNull()
    })
    // gitCommit 只被调用了一次（初始调用），没有第二次
    expect(fileAPI.gitCommit).toHaveBeenCalledTimes(1)
  })
```

- [ ] **Step 4: 运行前端测试验证通过**

Run: `npx vitest run src/web/components/TopBar.test.tsx src/web/components/CommitReviewDialog.test.tsx`
Expected: PASS — 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add src/web/components/CommitButton.tsx src/web/components/TopBar.test.tsx
git commit -m "feat: integrate commit review dialog into CommitButton"
```

---

## Self-Review Checklist

### 1. Spec coverage

| Spec 要求 | 对应 Task |
|---|---|
| Prompt 改造为 JSON 输出 | Task 5 Step 2 |
| maxTokens 200→400 | Task 5 Step 2 |
| JSON 解析失败 fail-closed | Task 5 Step 2 (`CHECK_PARSE_ERROR`) |
| `mode: 'force'` 跳过检查 | Task 5 Step 2 |
| `mode: 'append-ignore'` 追加 .gitignore | Task 5 Step 2 + Task 1 |
| `appendToGitignore` 函数 | Task 1 |
| 前端弹框三选项 | Task 7 + Task 8 |
| `gitCommit` API 支持 body | Task 6 |
| `CommitResponse` 联合类型 | Task 6 |
| `.gitignore` 不存在则创建 | Task 1 Step 3 (catch 块) |
| suggestions 去重 | Task 1 Step 3 |

✅ 全覆盖。

### 2. Placeholder scan

无 TBD/TODO/占位符。所有代码块完整。

### 3. Type consistency

- `CommitResponse` 在 `types/index.ts`（Task 6）和 `file.ts`（Task 6）中名称一致
- `appendToGitignore(cwd, patterns)` 签名在 Task 1（定义）和 Task 5（调用）一致
- `mockLLMResponse.value` 在 Task 2（定义）和 Task 3（override）一致
- `reviewState` 在 Task 8 中 `setReviewState`/`reviewState.suggestions`/`reviewState.message` 一致
- 弹框 props `onAppendIgnore`/`onForce`/`onCancel` 在 Task 7（定义）和 Task 8（调用）一致

✅ 无不一致。
