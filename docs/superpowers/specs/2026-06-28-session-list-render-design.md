# 会话内容渲染（列表式，对齐 opencode）设计

- **日期**: 2026-06-28
- **状态**: 待批准
- **范围**: 把 Web 端会话渲染从「气泡式」改造为 opencode 风格的「列表式」，功能点核心对齐
- **参考**: `~/projects/opencode/packages/web/src/components/share/part.tsx`（Share Web 渲染，818 行）

## 1. 目标与范围

### 目标
- 渲染架构从气泡式（用户右/助手左气泡，所有 part 塞一个气泡）改为**列表式**：每个消息 part 独立成块，左侧装饰栏（icon + timeline 竖线），右侧内容区。
- 功能点核心对齐 opencode 的 Share Web 渲染，覆盖 90% 可感知体验。
- **纯前端实现，不动后端 schema / AgentEvent 契约**。

### 非目标（本轮明确排除）
- `step-start` 模型展示（需后端新增 part 类型）
- `file` 附件 part（需后端新增 part 类型）
- 锚点复制消息链接、LSP diagnostics 集成、i18n
- 全量对齐的剩余项见后续迭代

## 2. 架构：列表式渲染

opencode 的核心特征：**每条消息的每个 Part 独立成块**（非气泡），左侧装饰栏，右侧内容。

```
│ icon │  内容块（text / thinking / tool …）
│  │   │
│ icon │  下一个 part 的内容块
│  │   │
```

- 废弃 `MessageBubble`（气泡）与 `ToolCall`（通用 JSON dump），删除文件并清理引用。
- 新增 `MessageItem`：单条消息 = 左装饰栏 + 右内容区，内部遍历「渲染块」序列。
- 装饰栏 icon 按 `role + part.type + tool` 分发（见 §7）。

## 3. 数据模型适配（纯前端归一化）

c0de-agent 的 `MessageContent` part 类型（`src/shared/types/message.ts`）：
```ts
type MessageContent =
  | { _tag: 'text'; text: string }
  | { _tag: 'tool_call'; id: string; tool: string; input: unknown }
  | { _tag: 'tool_result'; id: string; tool: string; output: ToolResult }
  | { _tag: 'thinking'; text: string }
  | { _tag: 'steering'; text: string }
```

列表式需要「一个工具调用 = 一个块」，但 c0de-agent 把 `tool_call` 与 `tool_result` 拆成两个独立 part（opencode 是聚合的带 state 的单 part）。**归一化在前端完成，不动后端**。

新增纯函数 `normalizeParts(message: Message): RenderBlock[]`：

```ts
type RenderBlock =
  | { type: 'text'; role: MessageRole; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'steering'; text: string }
  | {
      type: 'tool'
      id: string
      tool: string
      input: unknown
      status: 'running' | 'completed' | 'error' | 'paused'
      output?: ToolResult
    }
```

归并规则：
- `text` / `thinking` / `steering` → 直接映射。
- `tool_call` → 创建 `tool` 块，`status='running'`（无对应 result 时）。
- `tool_result` → 找到同 `id` 的 `tool` 块，按 `output._tag` 更新状态：
  - `success` | `truncated` → `completed`
  - `error` → `error`
  - `permission_required` → `paused`
- 若 `tool_result` 无对应 `tool_call`（历史数据/异常），仍渲染为 `tool` 块（`status` 由 `output._tag` 推导）。

纯函数，单测覆盖：tool_call+tool_result 合并、各状态、孤立 result、纯文本消息。

## 4. 组件结构

新增目录 `src/web/components/session/`：

```
MessageItem.tsx          替代 MessageBubble：左装饰栏 + 右内容区，遍历 RenderBlock[]
PartDecoration.tsx       icon(role+type+tool 分发) + timeline 竖线
UserTextBlock.tsx        用户文本（溢出折叠）
AssistantTextBlock.tsx   markdown + CopyButton + 溢出折叠 + 完成时间
ReasoningBlock.tsx       可折叠思考块（默认折叠，点击展开 markdown）
ToolBlock.tsx            标题(工具名+参数摘要) + 状态icon + 耗时 + 专用渲染器分发
hooks/useOverflow.ts     ResizeObserver 检测高度超阈值 → 展开/收起
utils/normalizeParts.ts  归一化纯函数
utils/toolIcons.ts       tool name → icon 映射
tools/
  ReadToolView.tsx       文件名 + 代码高亮（按扩展名选语言）
  WriteToolView.tsx      文件名 + 新增内容高亮
  EditToolView.tsx       文件名 + diff（oldText/newText 行级对比）
  BashToolView.tsx       命令(bash高亮) + 输出(console高亮) + exit code
  GrepToolView.tsx       pattern + 匹配结果折叠
  GlobToolView.tsx       pattern + 文件列表
  FallbackToolView.tsx   通用兜底（参数拍平展示 input）
```

**复用不动**：`Markdown`、`CodeBlock`、`StreamingIndicator`、`InputArea`、`PermissionDialog`、`useChat`、`AgentEvent`、`highlightCode`、`marked` 配置。

## 5. 工具专用渲染器

依据各工具 input/output 实际字段（`src/tools/builtin/`）：

| 工具 | input 关键字段 | 渲染要点 |
|---|---|---|
| `read` | `path, offset?, limit?` | 文件名（按扩展名选 shiki 语言）+ 内容高亮，溢出折叠 |
| `write` | `path, content` | 文件名 + 新增 content 代码高亮 |
| `edit` | `path, oldText, newText` | 文件名 + **行级 diff**：`diffLines(oldText,newText)` → `-` 行红 / `+` 行绿 / unchanged 灰，借鉴 opencode `ContentDiff` 的 modified 配对着色 |
| `bash` | `command, cwd?, timeout?` | command（shiki bash）+ output（shiki console）+ exit code（从 `output.metadata`） |
| `grep` | `pattern, path?` | pattern（标题）+ output 匹配结果文本折叠 |
| `glob` | `pattern, path?` | pattern（标题）+ output 文件路径列表 |
| 兜底 | input 全量 | `FallbackToolView`：参数拍平展示 |

### edit 的 diff 方案（借鉴 opencode）
- c0de-agent 的 edit input 是 `{oldText, newText}`（非 unified patch），无法直接用 opencode 的 `parsePatch`。
- 改用同依赖 `diff` 包的 **`diffLines(oldText, newText)`**，得到 `{added?, removed?, value}` 序列，渲染成行级 +/- 着色。
- 新增依赖：`diff`（npm）。视觉对齐 opencode `ContentDiff`（删除红底、新增绿底、同行替换 modified 高亮）。

### 工具状态与耗时
- 状态 icon：`running`（⏳/spinner）、`completed`（✓）、`error`（✗）、`paused`（🔒）。
- 耗时：当前无 `time.start/end`（AgentEvent 未提供工具耗时）。本轮**仅按状态渲染**，耗时 footer 留接口，待 AgentEvent 扩展后接入。

## 6. 内容组件与通用机制

- `Markdown` / `CodeBlock`：沿用（marked + shiki）。
- `CopyButton`：新增（clipboard 写入 + copied 状态反馈 2s）。复用于 AssistantTextBlock / 工具结果。
- `useOverflow`：新增 hook，ResizeObserver 监听内容高度，超阈值（如 300px）显示「展开/收起」。
- 溢出折叠应用于：用户文本、助手 markdown、read/write 代码、grep/glob 结果、bash 输出。

## 7. 装饰栏 icon 系统

`PartDecoration`：左侧 icon（按 `role + block.type + tool` 分发）+ 垂直 timeline 竖线连接相邻 part。

| role + type | icon |
|---|---|
| user + text | 用户圆圈 |
| assistant + text | sparkles（默认助手）|
| thinking | 脑 |
| tool: read/write/edit/bash/grep/glob | 各自工具 icon |
| tool: 其他 | 通用工具 icon |

icon 来源：内联 SVG 组件（不引第三方 icon 库，保持 c0de-agent 现有依赖最小化）。timeline 竖线用 CSS `::before` 伪元素绘制。

## 8. 流式集成（不变后端契约）

`useChat` + `AgentEvent` 契约不变。前端响应：
- `text_delta` → 追加到当前 assistant 消息的 `text` part → `AssistantTextBlock` 实时重渲染。
- `tool_call_start` → 新增 `tool_call` part（status running）→ `ToolBlock` 显示 running。
- `tool_call_end` → 追加 `tool_result` part → `normalizeParts` 合并 → `ToolBlock` 状态转 completed/error。
- 滚动到底部、中止、权限确认行为保留（`Chat.tsx` 的 `bottomRef`/abort/PermissionDialog 不动）。

`Chat.tsx` 改动：`messages.map(m => <MessageBubble/>)` → `<MessageItem/>`。

## 9. 样式

- 沿用 **Linaria**（`@linaria/core` / `@linaria/react`），不复刻 opencode 的 CSS Module。
- 沿用现有 CSS 变量：`--border` / `--bg` / `--bg-secondary` / `--text` / `--text-secondary` / `--primary` / `--code-bg` / `--danger`。
- 新增语义变量（如 diff 的 `--diff-add-bg` / `--diff-del-bg`，可在 `styles/theme.ts` 扩展）。

## 10. 测试

遵循 AGENTS.md 测试放置规范（复用现有文件，不建孤岛）：
- `normalizeParts` 纯函数单测 → 新增 `src/web/components/session/utils/normalizeParts.test.ts`（纯逻辑、无合适现有文件归属，注明来源）。
- 各 `ToolView` render → 追加到现有 `src/web/components/` 测试或新建 session 工具测试文件。
- `MessageItem` 列表式渲染 → 复用/扩展 Chat 相关测试。
- 断言：装饰栏 icon 分发、工具状态 icon、diff 行着色、溢出折叠交互、流式追加。

## 11. 影响文件

**新增**（`src/web/components/session/` 下）：
- `MessageItem.tsx`、`PartDecoration.tsx`、`UserTextBlock.tsx`、`AssistantTextBlock.tsx`、`ReasoningBlock.tsx`、`ToolBlock.tsx`
- `tools/{Read,Write,Edit,Bash,Grep,Glob,Fallback}ToolView.tsx`
- `hooks/useOverflow.ts`、`utils/normalizeParts.ts`、`utils/toolIcons.ts`

**新增**（`src/web/components/` 下）：
- `CopyButton.tsx`（通用，非 session 专属）

**修改**：
- `src/web/views/Chat.tsx`（`MessageBubble` → `MessageItem`）
- `package.json`（新增 `diff` 依赖）
- `src/web/styles/theme.ts`（diff 语义变量）

**删除**：
- `src/web/components/MessageBubble.tsx`
- `src/web/components/ToolCall.tsx`

## 12. 实现顺序（供 plan 参考）

1. 新增 `diff` 依赖 + `normalizeParts` 纯函数 + 单测（数据层基础）。
2. `useOverflow` hook + `CopyButton`（通用机制）。
3. `PartDecoration` + icon 系统 + `MessageItem` 骨架（架构落地，能渲染纯文本/thinking）。
4. 6 个 `ToolView` + `ToolBlock` 分发（按 read→write→edit(diff)→bash→grep→glob→fallback 顺序）。
5. `Chat.tsx` 切换 + 删除旧组件 + 清理引用。
6. 流式联调 + 样式打磨 + 测试补全。
