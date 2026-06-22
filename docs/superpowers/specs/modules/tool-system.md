# 工具系统详细设计

> 基于 pi、opencode、oh-my-openagent、oh-my-pi/hashline 的实现分析。

## 1. 参考项目分析

### 1.1 Pi（coding-agent/core/tools）

**工具定义**：
```typescript
// AgentTool 接口（packages/agent/src/types.ts）
type AgentTool = {
  name: string
  description: string
  parameters: JSONSchema
  execute: (input: unknown, context: ToolContext) => Promise<AgentToolResult>
}

type AgentToolResult = {
  type: 'text' | 'image' | 'error'
  text?: string
  image?: { base64: string; mediaType: string }
  error?: string
}
```

**工具实现模式**：
- `tool-definition-wrapper.ts`：包装器，统一处理输入验证、错误捕获、输出格式化
- `bash.ts`（446 行）：shell 执行，支持超时、abort signal、进程树 kill、输出截断
- `read.ts`：文件读取，支持行范围选择、图片 base64 编码
- `write.ts`：文件写入，支持 diff 模式
- `edit.ts` / `edit-diff.ts`：基于 search/replace 的文件编辑
- `output-accumulator.ts`（223 行）：输出累积器，处理大输出截断

**关键设计**：
- 工具执行返回 `AgentToolResult` 联合类型，支持文本、图片、错误
- bash 工具支持进程树 kill（不只杀主进程）
- 输出截断：超过阈值自动截断，保留头尾

### 1.2 OpenCode（tool/）

**工具定义**（`tool.ts`，184 行）：
```typescript
type Tool = {
  id: string
  description: string
  parameters: JSONSchema
  execute: (params: unknown, ctx: ToolContext) => Promise<ToolResult>
}

type ToolResult = {
  title: string
  output: string
  metadata?: Record<string, unknown>
}
```

**权限系统**（`permission/index.ts`，231 行）：
- 工具分为 `auto`（自动执行）和 `confirm`（需要确认）
- 权限检查在执行前进行
- 确认请求通过 WebSocket 推送到前端
- 用户确认后恢复执行

**输出截断**（`truncate.ts`，161 行）：
- 智能截断：保留头尾，中间用 `[... truncated ...]` 标记
- 按行截断和按字符截断两种模式
- 可配置截断阈值

**Shell 工具**（`shell.ts`，302 行）：
- 支持超时（默认 120s）
- 输出流式捕获（stdout + stderr 合并）
- 工作目录设置
- 环境变量注入

### 1.3 Oh-My-OpenAgent（plugin/tool-registry）

**工具注册**（`tool-registry.ts`，304 行）：
- 中央工具工厂编排器
- 组装 ~40 个工具定义
- 优先级排序（`LOW_PRIORITY_TOOL_ORDER`，26 个工具名）
- 团队模式条件注册
- 多类别工具分类

**工具工厂模式**：
```typescript
// 每个工具是一个工厂函数
type ToolFactory = (ctx: ToolFactoryContext) => ToolDef | null

// 返回 null 表示该工具不适用（如缺少依赖）
```

**Hashline Edit 工具**（`tools/hashline-edit/`）：
- `tools.ts`：工具定义，注册为 `edit` 工具
- `hashline-edit-executor.ts`（179 行）：执行器，解析 patch → 验证哈希 → 应用编辑
- `normalize-edits.ts`：归一化编辑输入
- `edit-operations.ts`：编辑操作实现

### 1.4 Oh-My-Pi（hashline）

**Hashline 核心**（`packages/hashline/`）：

**类型**（`types.ts`，170 行）：
```typescript
type Anchor = {
  path: string
  hash: string          // 4 位 hex 内容哈希
}

type Edit =
  | { _tag: 'swap'; range: LineRange; content: string }
  | { _tag: 'del'; range: LineRange }
  | { _tag: 'ins_pre'; line: number; content: string }
  | { _tag: 'ins_post'; line: number; content: string }
  | { _tag: 'ins_head'; content: string }
  | { _tag: 'ins_tail'; content: string }
  | { _tag: 'swap_blk'; block: BlockSpan; content: string }
  | { _tag: 'del_blk'; block: BlockSpan }
  | { _tag: 'ins_blk_post'; block: BlockSpan; content: string }

type ApplyResult =
  | { _tag: 'success'; content: string }
  | { _tag: 'hash_mismatch'; expected: string; actual: string }
  | { _tag: 'line_not_found'; edit: Edit }
  | { _tag: 'parse_error'; message: string }
```

**Parser**（`parser.ts`，306 行）：
- 语法：`[PATH#HASH]` 头 + 操作行
- 操作类型：SWAP、DEL、INS.PRE/POST/HEAD/TAIL、SWAP.BLK、DEL.BLK、INS.BLK.POST
- 恢复启发式：处理模型输出噪声（多余空白、错误前缀等）

**Patcher**（`patcher.ts`，309 行）：
- 读取文件 → 归一化 → 应用编辑 → 写回
- 多段 preflight：验证所有锚点哈希
- Stale anchor 检测：文件被修改后旧锚点失效
- Session-aware 3-way merge 恢复

**Input Parser**（`input.ts`，107 行）：
- 分割输入为多个 `PatchSection`（每个 `[PATH#HASH]` 头一个）
- 处理 `apply_patch` 噪声（`Update File:` 前缀等）
- 恢复解析畸形头部

---

## 2. c0de-agent 工具系统设计

### 2.1 架构

```
src/tools/
├── types.ts           类型定义
├── registry.ts        工具注册表
├── executor.ts        工具执行器
├── permission.ts      权限系统
├── truncate.ts        输出截断
├── builtin/
│   ├── read.ts        文件读取
│   ├── write.ts       文件写入
│   ├── edit.ts        文件编辑（diff + hashline 双模式）
│   ├── bash.ts        Shell 执行
│   ├── glob.ts        文件搜索
│   ├── grep.ts        内容搜索
│   ├── ast_grep.ts    AST 结构搜索
│   ├── ast_edit.ts    AST 结构编辑
│   ├── lsp.ts         LSP 操作
│   ├── browser.ts     浏览器控制
│   ├── task.ts        子 agent
│   ├── worktree.ts    Git worktree
│   └── websearch.ts   网络搜索
├── hashline/
│   ├── parser.ts      Patch 解析器
│   ├── patcher.ts     Patch 应用器
│   ├── types.ts       Hashline 类型
│   └── index.ts
└── index.ts
```

### 2.2 工具定义

```typescript
type ToolDef = {
  name: string
  description: string
  parameters: JSONSchema
  permission: ToolPermission
  execute: ToolExecutor
  modes?: ToolMode[]           // 可选的多种执行模式
}

type ToolPermission = 'auto' | 'ask' | 'deny'

type ToolMode = {
  name: string
  description: string
  isAvailable: (ctx: ToolContext) => boolean
}

type ToolExecutor = (input: unknown, ctx: ToolContext) => Promise<ToolResult>

type ToolContext = {
  cwd: string
  session: SessionRef
  abort: AbortSignal
  mode?: string                // 当前选择的工具模式
}

type ToolResult =
  | { _tag: 'success'; output: string; metadata?: Record<string, unknown> }
  | { _tag: 'error'; error: string }
  | { _tag: 'permission_required'; reason: string }
  | { _tag: 'truncated'; output: string; truncated: boolean; totalLines: number }
```

### 2.3 工具注册表

```typescript
type ToolRegistry = {
  tools: Map<string, ToolDef>
  factories: Map<string, ToolFactory>  // 延迟加载的工具工厂
}

type ToolFactory = (ctx: ToolFactoryContext) => ToolDef | null

type ToolFactoryContext = {
  config: Config
  cwd: string
}

// 创建注册表
export function createToolRegistry(): ToolRegistry

// 注册工具（立即）
export function registerTool(registry: ToolRegistry, tool: ToolDef): void

// 注册工具工厂（延迟加载）
export function registerToolFactory(registry: ToolRegistry, name: string, factory: ToolFactory): void

// 获取工具（如果工厂未加载，此时加载）
export function getTool(registry: ToolRegistry, name: string, ctx?: ToolFactoryContext): ToolDef | undefined

// 列出所有工具
export function listTools(registry: ToolRegistry, ctx?: ToolFactoryContext): ToolDef[]

// 获取工具的 JSON Schema 描述（用于 LLM）
export function getToolSchemas(registry: ToolRegistry, ctx?: ToolFactoryContext): ChatTool[]
```

### 2.4 工具执行器

```typescript
// 执行工具
export async function executeTool(
  registry: ToolRegistry,
  name: string,
  input: unknown,
  ctx: ToolContext,
  permissionChecker: PermissionChecker
): Promise<ToolResult> {
  // 1. 查找工具
  const tool = getTool(registry, name)
  if (!tool) return { _tag: 'error', error: `Tool not found: ${name}` }

  // 2. 验证输入（JSON Schema）
  const validation = validateInput(tool.parameters, input)
  if (!validation.valid) return { _tag: 'error', error: validation.error }

  // 3. 检查权限
  const permission = await permissionChecker.check(tool, input, ctx)
  if (permission._tag === 'deny') return { _tag: 'error', error: 'Permission denied' }
  if (permission._tag === 'ask') return { _tag: 'permission_required', reason: permission.reason }

  // 4. 执行工具
  try {
    const result = await tool.execute(input, ctx)

    // 5. 截断大输出
    if (result._tag === 'success' && result.output.length > MAX_OUTPUT_LENGTH) {
      return truncateResult(result)
    }

    return result
  } catch (error) {
    return { _tag: 'error', error: String(error) }
  }
}
```

### 2.5 权限系统

```typescript
type PermissionChecker = {
  check: (tool: ToolDef, input: unknown, ctx: ToolContext) => Promise<PermissionResult>
  confirm: (toolCallId: string, approved: boolean) => void
}

type PermissionResult =
  | { _tag: 'allow' }
  | { _tag: 'deny'; reason: string }
  | { _tag: 'ask'; reason: string; toolCallId: string }

export function createPermissionChecker(config: Config): PermissionChecker
```

**权限规则**：
- `auto`：自动允许（read、glob、grep、ast_grep 等只读工具）
- `ask`：需要用户确认（write、edit、bash、browser 等写入/执行工具）
- `deny`：始终拒绝（配置中禁用的工具）

**确认流程**：
1. 工具返回 `permission_required`
2. 通过 WebSocket 推送确认请求到前端
3. 前端显示确认弹窗（工具名、输入参数预览）
4. 用户确认/拒绝
5. 前端调用 `/api/tools/:name/confirm`
6. 恢复执行

### 2.6 输出截断

```typescript
type TruncateOptions = {
  maxLines: number         // 最大行数（默认 2000）
  maxChars: number         // 最大字符数（默认 100000）
  headLines: number        // 保留头部行数（默认 50）
  tailLines: number        // 保留尾部行数（默认 50）
}

export function truncateOutput(output: string, opts?: TruncateOptions): {
  output: string
  truncated: boolean
  totalLines: number
  totalChars: number
}
```

### 2.7 Bash 工具

```typescript
type BashInput = {
  command: string
  cwd?: string
  timeout?: number         // 超时秒数（默认 120）
  env?: Record<string, string>
}

// 执行流程：
// 1. 解析命令
// 2. 设置超时（AbortSignal.timeout）
// 3. 执行命令（child_process.spawn）
// 4. 捕获 stdout + stderr
// 5. 超时时 kill 进程树（不只杀主进程）
// 6. 截断大输出
// 7. 返回结果
```

**进程树 Kill**（参考 pi）：
```typescript
function killProcessTree(pid: number): void {
  // Linux: kill -pgid pid
  // macOS: kill -pgid pid
  // Windows: taskkill /F /T /PID pid
}
```

### 2.8 Edit 工具（双模式）

```typescript
type EditInput =
  | { mode: 'diff'; path: string; search: string; replace: string }
  | { mode: 'hashline'; path: string; patch: string }
  | { path: string; search: string; replace: string }  // 默认 diff 模式
  | { path: string; patch: string }                     // 自动检测 hashline

export async function editTool(input: EditInput, ctx: ToolContext): Promise<ToolResult> {
  // 自动检测模式
  const mode = input.mode ?? ('patch' in input ? 'hashline' : 'diff')

  if (mode === 'diff') {
    return applyDiffEdit(input as DiffInput, ctx)
  } else {
    return applyHashlineEdit(input as HashlineInput, ctx)
  }
}
```

### 2.9 Hashline 实现

**完整类型定义**（参考 oh-my-pi/hashline/types.ts）：

```typescript
// ── 锚点与光标 ──────────────────────────────

/** 行号锚点（1-indexed） */
type Anchor = { line: number }

/** 插入位置 */
type Cursor =
  | { kind: 'bof' }
  | { kind: 'eof' }
  | { kind: 'before_anchor'; anchor: Anchor }
  | { kind: 'after_anchor'; anchor: Anchor }

// ── 编辑操作 ──────────────────────────────

/** 单个低级编辑操作 */
type Edit =
  | {
      kind: 'insert'
      cursor: Cursor
      text: string
      lineNum: number
      index: number
      mode?: 'replacement'
      blockStart?: number
    }
  | {
      kind: 'delete'
      anchor: Anchor
      lineNum: number
      index: number
      oldAssertion?: string  // 旧内容断言（stale 检测）
    }
  | {
      // 延迟块编辑：replace_block / delete_block / insert_after_block
      // 解析时不知道精确行范围，由 resolveBlockEdits 在文件文本可用后展开
      kind: 'block'
      anchor: Anchor
      payloads: string[]
      mode?: 'insert_after'
      lineNum: number
      index: number
    }

// ── 应用结果 ──────────────────────────────

type ApplyResult = {
  text: string
  firstChangedLine?: number
  warnings?: string[]
  blockResolutions?: BlockResolution[]
}

// ── 块操作 ──────────────────────────────

type BlockSpan = { start: number; end: number }

type BlockResolution = {
  anchorLine: number
  start: number
  end: number
  op: 'replace' | 'delete' | 'insert_after'
}

type BlockResolverRequest = {
  path: string
  text: string
  line: number
}

/** 块解析器：由 host 注入 tree-sitter 实现 */
type BlockResolver = (request: BlockResolverRequest) => BlockSpan | null

// ── 辅助类型 ──────────────────────────────

type ParsedRange = { start: Anchor; end: Anchor }

/** 内容哈希（4 位 hex） */
export function computeHash(content: string): string
```

**Parser**（`parser.ts`，306 行）：

```typescript
// 正式语法：[PATH#HASH] 头 + 操作行
// SWAP lineStart-lineEnd     → 替换行范围
// SWAP.BLK N                 → 替换语法块
// DEL lineStart-lineEnd      → 删除行范围
// DEL.BLK N                  → 删除语法块
// INS.PRE line               → 在行前插入
// INS.POST line              → 在行后插入
// INS.HEAD                   → 在文件头插入
// INS.TAIL                   → 在文件尾插入
// INS.BLK.POST N             → 在语法块后插入

export function parsePatch(input: string): ParsedPatch[]
export function splitPatchInput(input: string, opts?: SplitOptions): PatchSection[]

// 恢复启发式：处理模型输出噪声（多余空白、错误前缀、缺失 header）
export function recoverFromNoisyInput(input: string): ParsedPatch[]
```

**Patcher**（`patcher.ts`，309 行）：

```typescript
// 多段 preflight：验证所有锚点哈希
export function preflight(sections: PatchSection[], files: Map<string, string>): PreflightResult

// 应用 patch
export async function applyPatch(
  filePath: string,
  patches: ParsedPatch[],
  fs: FileSystem,
  blockResolver?: BlockResolver
): Promise<ApplyResult>

// Stale anchor 检测
export function detectStaleAnchor(content: string, expectedHash: string): boolean

// Session-aware 3-way merge 恢复
export function recoverFromStale(
  original: string,
  current: string,
  patch: ParsedPatch
): Promise<ApplyResult>

// 块编辑解析（延迟展开）
export function resolveBlockEdits(
  edits: Edit[],
  text: string,
  path: string,
  resolver: BlockResolver
): Edit[]
```

**Apply Engine**（`apply.ts`）：

```typescript
// 编辑降级：将高级编辑分解为 insert + delete
export function lowerEdits(edits: Edit[]): Edit[]

// 行解析：将锚点转为具体行号
export function resolveLineNumbers(edits: Edit[], text: string): Edit[]

// 文件文本变更
export function applyEdits(text: string, edits: Edit[]): ApplyResult
```

**Input Parser**（`input.ts`，107 行）：

```typescript
// 分割输入为多个 PatchSection
export function splitPatchInput(input: string, opts?: SplitOptions): PatchSection[]

// 处理 apply_patch 噪声（Update File: 前缀等）
export function stripNoise(input: string): string
```

### 2.10 内置工具摘要

| 工具 | 权限 | 模式 | 描述 |
|------|------|------|------|
| `read` | auto | — | 文件读取，支持行范围、内部 URL、图片 base64 |
| `write` | ask | — | 文件写入，创建或覆盖 |
| `edit` | ask | diff / hashline | 文件编辑，自动检测模式 |
| `bash` | ask | — | Shell 执行，支持超时、进程树 kill |
| `glob` | auto | — | 文件名搜索（glob 模式） |
| `grep` | auto | — | 内容搜索（正则） |
| `ast_grep` | auto | — | AST 结构搜索（tree-sitter） |
| `ast_edit` | ask | — | AST 结构编辑（预览后应用） |
| `lsp` | auto | — | LSP 操作（定义/引用/重命名/diagnostics） |
| `browser` | ask | — | 浏览器控制（Puppeteer） |
| `task` | auto | — | 子 agent（worktree 隔离） |
| `worktree` | ask | — | Git worktree 管理 |
| `websearch` | auto | — | 网络搜索 |
