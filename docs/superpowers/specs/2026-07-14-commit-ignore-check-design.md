# 提交前 LLM 忽略检查

> 日期：2026-07-14
> 关联代码：`src/server/routes/files.ts`（`/git-commit` 路由）、`src/project/resolve.ts`（`getGitDiffSummary`/`performGitCommit`）、`src/web/components/CommitButton.tsx`

## 问题

当前一键提交流程（`POST /api/files/git-commit`）直接 `git add -A` + `git commit`，LLM 仅参与生成 commit message。如果 `.gitignore` 漏写了某些文件（密钥、构建产物、依赖目录、临时文件等），它们会被一并提交。**没有任何环节检查"待提交文件中是否有该被忽略却漏加 `.gitignore` 的"。**

代码中现有的 `checkIgnored()` 函数方向反了——它查的是"路径是否已被 gitignore 覆盖"，且只在文件浏览器列表中使用，提交流程不碰它。

## 方案

将忽略检查交给 LLM，而非硬编码规则。复用生成 commit message 时已获取的 diff，在同一次 LLM 调用中同时产出 commit message 和可疑文件列表。检测到可疑文件时**阻断提交**，前端弹确认框，用户可选择：

1. **加入 .gitignore 再提交** — 后端追加 `.gitignore` 条目后提交
2. **仍然提交** — 跳过检查直接提交（复用已生成的 message）
3. **取消**

### 决策记录

- **检测后行为**：阻断 + 可自动忽略（用户确认后再提交）
- **LLM 输入**：复用 diff（零额外 LLM 请求，与 commit message 生成合并为一次调用）
- **JSON 解析失败**：fail-closed（报错阻断，让用户知道检查失败，不静默提交）
- **commit message 复用**：二次调用（force / append-ignore）回传首次生成的 message，不再调 LLM

## 数据流

```
点击提交 → POST /git-commit（无 body）
  ↓
getGitDiffSummary → diff（已有逻辑，零改动）
  ↓
LLM 单次调用（改造 prompt）：同时返回 commit message + 可疑文件列表
  输出 JSON: { "message": "feat: …", "ignoreSuggestions": [".env", "dist/"] }
  ↓
JSON 解析失败 → 返回 502 CHECK_PARSE_ERROR（阻断，不提交）
  ↓
ignoreSuggestions 非空？
  ├─ 是 → 返回 { needsReview: true, message, suggestions }  ← 不提交
  └─ 否 → performGitCommit → 返回 { committed: true, ... }

前端弹确认框（3 个选项）：
  ├─ "加入 .gitignore 再提交"
  │     → POST /git-commit body { mode:'append-ignore', message, suggestions }
  │     后端追加 .gitignore → performGitCommit
  ├─ "仍然提交"
  │     → POST /git-commit body { mode:'force', message }
  │     跳过检查 → performGitCommit
  └─ "取消"
```

## 后端改动

### 1. Prompt 改造（`src/server/routes/files.ts`）

从"只生成 commit message"变为"生成 message + 检查可疑文件"，要求 JSON 输出：

```text
Based on the following git diff, generate a concise commit message
in conventional-commits format (e.g. "feat: add login page").

ALSO review the changed/new files: are any of them files that SHOULD
be in .gitignore but are currently missing? (e.g. secrets, .env,
build output, dependencies, temp files, large binaries)

Reply as JSON ONLY:
{"message": "<commit message>", "ignoreSuggestions": ["<path>", ...]}

If no files need ignoring, return an empty array for ignoreSuggestions.

${diff.slice(0, 8000)}
```

- `maxTokens` 从 200 提到 400（JSON 比纯文本长）。
- 保留原有的 markdown 代码块去包裹逻辑（先去 ` ``` ` 再 JSON.parse）。

### 2. JSON 解析与错误处理

- 解析成功 → 提取 `message` 和 `ignoreSuggestions`（数组）。
- 解析失败 → 返回 `502 CHECK_PARSE_ERROR`：`"Commit ignore check failed: LLM returned unparseable response"`。**阻断，不提交。**
- `message` 为空 → 返回 `502 EMPTY_MESSAGE`（同现行逻辑）。

### 3. POST body `mode` 参数

| mode | 额外字段 | 行为 |
|---|---|---|
| 无（默认） | — | 执行检查；无误则提交，有误则阻断返回 needsReview |
| `force` | `message` | 跳过检查，用传入的 message 直接 `performGitCommit` |
| `append-ignore` | `message`, `suggestions` | 追加 `.gitignore` 后用传入的 message `performGitCommit` |

### 4. 新增函数 `appendToGitignore`（`src/project/resolve.ts`）

```ts
/** 追加条目到 .gitignore（去重，文件不存在则创建）。 */
export function appendToGitignore(cwd: string, patterns: string[]): void
```

- 读现有 `.gitignore`（不存在则视为空）。
- 过滤掉已存在的条目（精确行匹配，trim 后比较）。
- 追加新条目（每行一个，末尾换行）。
- 写回 `.gitignore`。

## 前端改动

### `src/web/services/file.ts`

`gitCommit` 支持传 body：

```ts
gitCommit: (projectId?: string, body?: { mode?: string; message?: string; suggestions?: string[] }) =>
  apiRequest<CommitResponse>(
    `/api/files/git-commit${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    { method: 'POST', body: body ? JSON.stringify(body) : undefined },
  )
```

`CommitResponse` 为联合类型：

```ts
type CommitResponse =
  | { committed: true; message: string; hash: string; fileCount: number }
  | { needsReview: true; message: string; suggestions: string[] }
```

### `src/web/components/CommitButton.tsx`

- `commitMut` 的 `onSuccess` 判断响应类型：
  - `committed: true` → 现行逻辑（显示"✓ 已提交"）。
  - `needsReview: true` → 不显示成功，弹出确认框。
- 确认框：列出 `suggestions`，三个按钮：
  - "加入 .gitignore 再提交" → `gitCommit(projectId, { mode:'append-ignore', message, suggestions })`
  - "仍然提交" → `gitCommit(projectId, { mode:'force', message })`
  - "取消" → 关闭弹框
- 二次调用成功后走正常的 `committed` 路径。

## 边界情况

| 场景 | 处理 |
|---|---|
| LLM 返回无法 JSON.parse | 502 阻断，提示用户检查失败 |
| LLM 返回 `ignoreSuggestions: []` | 正常提交（无漏忽略文件） |
| LLM 误报可疑文件 | 用户选"仍然提交"绕过 |
| `.gitignore` 不存在 | `appendToGitignore` 创建新文件 |
| `suggestions` 含已在 `.gitignore` 中的条目 | `appendToGitignore` 去重跳过 |
| diff 超 8000 字符被截断 | 截断的 diff 可能漏检，属可接受限制（与现行 commit message 生成一致） |
| force / append-ignore 模式无 `message` | 返回 400 `MISSING_MESSAGE` |
