# 消息发送框（Composer）对齐 opencode 设计

> 状态：已通过 5 节设计评审（2026-06-30），用户逐节确认。
> 参考：`../opencode/packages/app/src/components/prompt-input.tsx`（2249 行，SolidJS）

## 目标

将 c0de-agent 当前仅支持纯文本的 `InputArea`（70 行 textarea + 硬编码斜杠菜单）对齐 opencode 的 composer 能力。前后端都要对齐。

## 范围

### 纳入（5 个能力模块 + contenteditable 编辑器）

- contenteditable 富文本编辑器内核（替代 textarea）
- 编辑体验增强：历史上/下键回溯、粘贴大段折叠、拖拽文本、动态占位符
- 斜杠命令系统：拉取后端 registry，分类/模糊搜索/键盘导航
- 发送/停止键一体化（流式时变停止键）
- 图片附件多模态（粘贴/拖拽/选择 → dataURL → 缩略图条 → 随消息发送）
- @ 文件上下文提及（pill + 文件内容注入上下文）
- permission 从模态弹窗迁移为 dock 形态（对齐 opencode）

### 排除（需独立立项）

- question / followup / revert / todo 四个 dock：后端 `AgentEvent` 无对应变体，每个都是独立子系统。
- @agent pill：c0de-agent 无 subagent 概念。
- shell 模式（`!` 前缀）：opencode 特有。

## 后端现状（关键利好）

后端多模态在 LLM 层已完全就绪，改造量小：

- `ContentPart`（`shared/types/llm.ts`）已有 `{type:'image', mediaType, data}`，`ChatMessage.content: string | ContentPart[]`
- `ModelCapabilities.supportsVision` 已存在
- 文件快照机制已存在：`upsertFileSnapshot` + `injectSnapshots`（文件内容作为 system message 注入），`@文件` 直接复用
- 斜杠命令 registry + `/api/chat` 路由拦截已存在（`createSlashRegistry`，6 个内置命令）
- `/api/files` 路由齐全（list/search/read/write）
- `sessionEntries.content` 是 jsonb，加 image 类型无需 DB migration

## 架构

### 第 1 节：整体架构

前端 React 重写 composer；后端打通多模态/文件上下文数据流（类型已具备，改 3 个转换函数 + 1 个端点）。

### 第 2 节：contenteditable 编辑器内核

**核心矛盾与解法**：React 与 contenteditable 冲突（两者都想管 DOM）。解法是编辑器完全非受控——React 只挂载空 `<div contenteditable>`，DOM 变更通过 ref 直接操作；`Prompt` 是由 `parseFromDOM()` 从 DOM 读取的影子状态，而非 React 渲染源。`Prompt` 用 ref 不用 state，否则 setState→重渲染→覆盖 DOM。

**数据结构**（移植 opencode `Prompt`）：
```ts
interface PartBase { start: number; end: number }  // 纯文本流字符偏移，BR=1
interface TextPart extends PartBase { type: 'text'; content: string }
interface FilePart extends PartBase { type: 'file'; path: string; content: string }
interface ImagePart { type: 'image'; mediaType: string; data: string }  // 无 start/end，不进编辑器 DOM
type ContentPart = TextPart | FilePart | ImagePart
type Prompt = ContentPart[]
```

**editor-dom 工具**（1:1 移植，纯 DOM 算法与框架无关）：
`createTextFragment` / `getNodeLength` / `getTextLength` / `getCursorPosition` / `setCursorPosition`。`setCursorPosition` 是光标恢复核心，保留 `\u200B` 处理。

**双向同步**：`parseFromDOM`（DOM→Prompt）/ `reconcile`（外部 Prompt→DOM，带光标恢复）。`onInput` 只 `parseFromDOM` 更新影子状态，**不回写 DOM**；仅外部变更（历史填充、pill 插入、清空）触发 reconcile。用 `mirror.input` 标志区分用户输入与外部写入。

**pill DOM 结构**：`<span data-type="file" data-path="..." contenteditable="false">`，`parseFromDOM` 靠 `data-type` 识别。Backspace 紧邻 pill 且为空时删整个 pill。

**3 个风险点**：
1. IME：监听 `compositionstart/compositionend`，组合期间冻结 reconcile。
2. 粘贴富文本：`onPaste` preventDefault + 手动插纯文本。
3. React StrictMode 双挂载：用 `useLayoutEffect` 确保 reconcile 在 paint 前完成。

### 第 3 节：编辑体验与 popover 交互

1. **历史回溯**：localStorage 键 `composer-history.v1`，存纯文本 string[]（不存 file/image），上限 100。↑仅首行触发，↓仅末行+回溯中触发。纯函数 `canNavigateHistoryAtCursor` / `navigatePromptHistory` / `prependHistoryEntry`。
2. **粘贴处理**：`≥8000 字符` 或 `≥120 行` 弹确认；含换行未达阈值直接插；单行原生。强制纯文本（preventDefault + 手动插）。图片粘贴走附件流程。
3. **拖拽**：`dragenter/over` 显示覆盖层，`drop` 按类型分流（图片/文本）。
4. **动态占位符**：steer 模式 / 空会话 / 正常三态。JS 判断 `promptLength===0` 显示 overlay。
5. **斜杠 popover**：**新增 `GET /api/commands`** 拉取 registry；`/` 开头无空格触发；↑/↓/Enter/Tab/Esc 导航。
6. **@文件 popover**：`@(\S*)$` 触发，调 `/api/files/search`；选中插 file pill + 读文件内容存入 FilePart。
7. **发送/停止键一体化**：空闲态发送键，流式态变停止键。移除 toolbar 中止按钮，保留 pause/resume。

**popover 调度**：同时只开一个，优先级 `slash > at`。popover 开时 ↑/↓ 归 popover。

### 第 4 节：后端数据流

**改动 1**：`MessageContent` 加 `{ _tag:'image'; mediaType; data }`（`shared/types/message.ts`）。

**改动 2**：`messageToChatMessage`（`session/context.ts`）含 image part 时返回 `ContentPart[]` 数组；无 image 走原路径（零回归）。

**改动 3**：`runAgent`（`core/agent.ts`）入参 `string → MessageContent[]`；标题生成用纯文本 join。

**改动 4**：`/api/chat`（`server/routes/chat.ts`）请求体加可选 `images: {mediaType,data}[]` 和 `files: string[]`。向后兼容：`message` 仍必填。

**文件上下文**：复用快照机制。chat 路由对每个 path `upsertFileSnapshot(db, sessionId, path, readFile(path))`，后续 `getSessionContext`→`injectSnapshots` 自动注入。安全：复用 `files.ts` 的 `safeResolve`（提取为共享 util 防路径穿越）。

**Vision 降级**：`supportsVision === false` 时前端缩略图条警告；本次实现到「正确传递」，provider 层降级已有框架。

**permission dock**：前端把 `PermissionDialog` 模态弹窗改成 composer 上方非阻塞 dock 条，`useChat.confirm` 逻辑不变。

### 第 5 节：验证策略

**纯函数单测**：editor-dom 光标往返、history 边界、paste 阈值、buildRequest、后端 messageToChatMessage 双路径、injectSnapshots 复用。

**集成测试**：`/api/chat` 多模态请求（归入 `chat.test.ts`）、`GET /api/commands`。

**E2E 关键路径**：输入→历史→发送光标不跳、IME 中文不丢字、图片粘贴→缩略图→后端收到 image part、@文件→pill→内容注入 system message。

**回归红线**：纯文本会话（无图片/文件）行为与改造前完全一致。

**测试放置**（遵循 AGENTS.md）：归入已有 skill-tests/integration 文件，禁孤岛；纯函数/后端测试归入对应已有文件或新建带归并注释。

## 文件结构

### 后端（新增/修改）
- 修改 `src/shared/types/message.ts`：MessageContent 加 image 变体
- 修改 `src/session/context.ts`：messageToChatMessage 多模态映射
- 修改 `src/core/agent.ts`：runAgent 入参 MessageContent[]
- 修改 `src/server/routes/chat.ts`：请求体 images/files，调用 upsertFileSnapshot
- 新增 `src/server/routes/commands.ts`：GET /api/commands
- 新增 `src/server/util/safe-path.ts`：safeResolve 提取共享
- 修改 `src/server/app.ts`：挂载 commands 路由
- 修改 `src/server/routes/files.ts`：safeResolve 改用共享 util

### 前端（新增/修改）
- 新增 `src/web/composer/types.ts`：Prompt/ContentPart
- 新增 `src/web/composer/editor-dom.ts`：DOM 光标工具（移植）
- 新增 `src/web/composer/editor-sync.ts`：parseFromDOM/reconcile 纯函数
- 新增 `src/web/composer/history.ts`：历史回溯纯函数
- 新增 `src/web/composer/paste.ts`：粘贴判定纯函数
- 新增 `src/web/composer/placeholder.ts`：占位符纯函数
- 新增 `src/web/composer/useComposer.ts`：编辑器 hook（非受控 + ref）
- 新增 `src/web/composer/ComposerEditor.tsx`：contenteditable 编辑器组件
- 新增 `src/web/composer/SlashPopover.tsx`：斜杠命令 popover
- 新增 `src/web/composer/AtFilePopover.tsx`：@文件 popover
- 新增 `src/web/composer/AttachmentBar.tsx`：图片缩略图 + 上下文 pill 条
- 新增 `src/web/composer/PermissionDock.tsx`：权限 dock
- 新增 `src/web/composer/Composer.tsx`：容器，编排上述组件
- 新增 `src/web/services/commands.ts` + `src/web/hooks/useCommands.ts`：命令拉取
- 新增 `src/web/services/files.ts`：文件搜索
- 修改 `src/web/services/chat.ts`：sendChatMessage 加 images/files
- 修改 `src/web/hooks/useChat.ts`：sendMessage 加 images/files
- 删除 `src/web/components/InputArea.tsx` + `SlashCommandMenu.tsx`（被 Composer 取代）
- 修改 `src/web/views/Chat.tsx`：用 Composer 替换 InputArea，permission dock 化
