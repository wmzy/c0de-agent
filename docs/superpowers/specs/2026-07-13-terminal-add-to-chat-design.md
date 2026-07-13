# 终端「Add to Chat」设计

> 日期：2026-07-13
> 背景：对齐 Cursor 的终端引用能力——用户可以在终端选中文本或悬停命令块时，左上角浮现「Add to Chat」按钮，点击将终端内容以 pill 形式引用到 Composer，发送时展开为带标注的代码块注入 LLM 上下文。

## 1. 需求

两个触发路径，共用一套注入机制：

1. **选区引用**：用户在终端选中文本 → 左上角浮现「Add to Chat」→ 点击注入
2. **命令块引用**：用户鼠标悬停某一行 → 自动高亮该行所属的命令块（输入 + 输出）→ 左上角浮现「Add to Chat」→ 点击注入整块

选区优先于命令块——用户主动选区时，命令块高亮和块引用让位。

## 2. 核心设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 命令块识别策略 | **输入追踪法**（前端 onData 追踪回车边界） | 后端零改动；覆盖 90%+ 用例；选区兜底剩余场景 |
| 注入 Composer 形式 | **TerminalPart pill** | 与现有 FilePart/SnippetPart 视觉一致 |
| 交互式程序检测 | `buffer.active.type === 'alternate'` | xterm.js 天然区分 normal/alternate buffer，vim/less/top 进入时自动切换 |
| Add to Chat 按钮位置 | 终端 pane 左上角 `absolute` | 与 Cursor 对齐，不遮挡终端内容 |

## 3. 新增 TerminalPart 内容类型

现有 Prompt 类型：`TextPart | FilePart | SnippetPart | ImagePart`。新增：

```ts
interface TerminalPart extends PartBase {
  type: 'terminal'
  /** pill 显示标签："🖥 终端选区" 或 "🖥 命令: ls -la" */
  label: string
  /** 实际终端文本（选区文本 或 命令+输出的完整内容） */
  content: string
}
```

### 3.1 类型系统改动（`composer/types.ts`）

| 工具函数 | 改动 |
|---|---|
| `ContentPart` union | 增加 `TerminalPart` |
| `promptLength` | terminal 贡献 `label.length`（与 snippet 一致） |
| `promptToText` | terminal 贡献 `label` 文本 |
| `promptToMessageText` | terminal 展开为 ```` ```terminal\n<content>\n``` ```` |
| `isPromptEmpty` | terminal 不算空（`!prompt.some(p => p.type === 'terminal')` 加入条件） |

展开后 LLM 收到的消息文本示例：

````
帮我分析这个测试输出 🖥 命令: npm test

```terminal
$ npm test
✓ all passed (42 tests)
```
````

### 3.2 编辑器同步（`composer/editor-sync.ts`）

| 函数 | 改动 |
|---|---|
| `createTerminalPill` | 新建：`<span data-type="terminal" data-content="..." class={pillStyle}>🖥 label</span>` |
| `parseFromDOM` | 增加 `data-type === 'terminal'` 分支，还原 TerminalPart |
| `renderPrompt` | 增加 `part.type === 'terminal'` 分支，调用 `createTerminalPill` |

Terminal pill 复用现有 `pillStyle`（与 file/snippet pill 共用样式），不新增 CSS。与 snippet pill 不同：terminal pill **无 hover tooltip、无 click 跳转**（终端内容不是文件引用）。

## 4. 命令块追踪算法

### 4.1 数据结构

```ts
interface CommandBlock {
  /** 终端绝对行号（baseY + cursorY），稳定标识，不受视口滚动影响 */
  startRow: number
  /** 命令文本（用户输入的原始命令，含换行续行符） */
  command: string
}
```

命令块 N 的行范围 = `[blocks[N].startRow, blocks[N+1].startRow)`，最后一个块的范围 = `[blocks[N].startRow, ∞)`（到当前光标行）。

### 4.2 边界追踪（`term.onData` 回调）

```
onData(data):
  for each char in data:
    if char === '\r':
      // 回车 = 命令边界
      const absRow = buffer.active.baseY + buffer.active.cursorY
      blocks.push({ startRow: absRow, command: currentInput })
      currentInput = ''
    else:
      currentInput += char
```

**关键点**：
- `baseY` 是 scrollback 偏移量，`cursorY` 是视口内行号，二者之和是绝对行号——在 scrollback 增长时仍稳定标识同一行。
- 不对 `\n`（非 `\r`）触发边界：终端里 `\n` 是换行输出，`\r` 才是用户按回车。

### 4.3 交互式程序跳过

```ts
// onData 开头检查
if (term.buffer.active.type === 'alternate') {
  // 在 vim/less/top 中，不追踪块
  return
}
```

xterm.js 在全屏程序进入时自动切换到 alternate buffer（独立缓冲区，退出时恢复 normal buffer 的原始内容）。这个机制天然准确，无需自己检测程序类型。

**额外保护**：从 alternate 切回 normal 时，清空 `currentInput`（避免把 vim 里的按键混入下一个命令）。

### 4.4 回滚修剪

当 scrollback 被裁剪（行号超过 `buffer.active.length`），旧块失效：

```ts
function pruneBlocks(term: XTerm): void {
  const maxRow = term.buffer.active.length
  blocks = blocks.filter(b => b.startRow <= maxRow)
}
```

在 onData 回调中，每次创建新块时顺手修剪（轻量，无需独立定时器）。被裁掉的块对应的行区域不再高亮，用户仍可用选区引用。

### 4.5 鼠标→行映射

```
mousemove(e):
  const rect = container.getBoundingClientRect()
  const cellHeight = rect.height / term.rows
  const row = Math.floor((e.clientY - rect.top) / cellHeight)
  const absRow = buffer.active.baseY + row
  // 查找 absRow 落在哪个块内
  hoverBlock = blocks.find((b, i) => {
    const endRow = blocks[i+1]?.startRow ?? Infinity
    return absRow >= b.startRow && absRow < endRow
  })
```

### 4.6 块高亮 overlay

绝对定位 div，覆盖 `hoverBlock` 对应的行范围：

```ts
// 计算块在视口内的像素范围
const startRow = hoverBlock.startRow - buffer.active.baseY  // 转视口行
const endRow = (blocks[idx+1]?.startRow ?? (buffer.active.baseY + term.rows)) - buffer.active.baseY
const top = startRow * cellHeight
const height = (endRow - startRow) * cellHeight
```

仅当 `selection` 为空时渲染高亮（选区优先）。

## 5. 组件改动

### 5.1 `components/Terminal.tsx`（核心改动）

新增 props：
```ts
interface TerminalProps {
  // ... 现有 props
  onAddToChat?: (label: string, content: string) => void
}
```

新增内部状态：
- `selection: string | null` — 当前选区文本（`term.onSelectionChange` → `term.getSelection()`）
- `blocks: CommandBlock[]` — 命令块数组（onData 追踪）
- `hoverBlock: { block: CommandBlock; top: number; height: number } | null`

新增副作用：
- `term.onData` 中累积输入 + 块边界追踪
- `term.onSelectionChange` 中更新 selection
- `mousemove` 中计算 hoverBlock（通过 containerRef）
- `alternate buffer` 切换检测（onData 中检查 + buffer.active.type 变化时清 currentInput）

渲染（在 container div 内，绝对定位）：
- **块高亮 overlay**：`position: absolute; background: rgba(74,158,255,0.08); border-left: 2px solid var(--primary)`，当 `!selection && hoverBlock` 时显示
- **Add to Chat 按钮**：`position: absolute; top: 4px; left: 8px`，当 `selection || hoverBlock` 时显示

按钮点击逻辑：
```ts
if (selection) {
  onAddToChat?.('🖥 终端选区', selection)
} else if (hoverBlock) {
  // 从 buffer 提取块对应的文本行
  const content = extractBlockText(term, hoverBlock.block, blocks)
  const label = `🖥 命令: ${truncate(hoverBlock.block.command, 30)}`
  onAddToChat?.(label, content)
}
```

`extractBlockText(term, block, blocks)`：遍历 `term.buffer.active.getLine(i)`（i 从 block.startRow 到下一个块的 startRow 或 `baseY + cursorY`），拼接每行 `line.translateToString(true)` 的结果。

### 5.2 `components/TerminalPanel.tsx`

`PaneSplitContainer` 内：调用 `useFileReference()` 获取 API，构造 `onAddToChat` 回调传给 `Terminal`：

```tsx
const fileRef = useFileReference()

const handleAddToChat = (label: string, content: string) => {
  fileRef?.insertTerminalReference(label, content)
}

// 传给 Terminal
<Terminal
  ws={getWebSocket(pane.id)}
  visible={visible}
  onResize={...}
  onAddToChat={handleAddToChat}
/>
```

### 5.3 `contexts/ReferenceContext.tsx`

`FileReferenceAPI` 新增方法：

```ts
export type FileReferenceAPI = {
  insertFileReference: (path: string) => void
  insertSnippetReference: (path: string, lineStart: number, lineEnd: number, snippet: string) => void
  insertTerminalReference: (label: string, content: string) => void  // 新增
}
```

### 5.4 `composer/useComposer.ts`

新增 `appendTerminalReference`（与 `appendSnippetReference` 同构）：

```ts
const appendTerminalReference = useCallback((label: string, content: string) => {
  const prompt = promptRef.current
  const parts: Prompt = [...prompt.filter(p => p.type === 'text' || p.type === 'file' || p.type === 'snippet' || p.type === 'terminal')]
  const text = promptToText(prompt)
  if (text.length > 0 && !text.endsWith(' ')) {
    parts.push({ type: 'text', content: ' ', start: 0, end: 1 })
  }
  parts.push({ type: 'terminal', label, content, start: 0, end: label.length })
  parts.push({ type: 'text', content: ' ', start: 0, end: 1 })
  setPromptExternal(parts, true)
  editorRef.current?.focus()
}, [setPromptExternal])
```

Composer 组件 `useEffect` 注册 API 时增加 `insertTerminalReference: composer.appendTerminalReference`。

## 6. 边界情况

| 场景 | 处理 |
|---|---|
| vim/less/top 等全屏程序 | `buffer.type === 'alternate'` 跳过块追踪；选区仍可用 |
| 多行命令（`\` 续行） | 续行符和换行包含在 currentInput 中，块行范围正确 |
| Tab 补全 / Ctrl+C / Ctrl+U | 创建边界，command 文本可能不完整——可接受，选区兜底 |
| 密码输入（无回显） | command 文本含原始输入但终端不回显——块行范围仍正确 |
| 鼠标在 prompt 行（刚回车，无输出） | 仍算一个块（命令行本身），content 为命令文本 |
| 选区与块同时存在 | 选区优先：显示选区文本，隐藏块高亮 |
| 终端尚未连接（ws=null） | 不显示 Add to Chat（无 buffer 可读） |
| 多 pane | 每个 Terminal 实例独立追踪各自的块和选区 |
| onAddToChat 未传入 | 按钮不渲染（向后兼容） |

## 7. 测试策略

### 7.1 单元测试

| 测试目标 | 文件 | 用例 |
|---|---|---|
| TerminalPart 类型 | `composer/types.ts` 配套测试 | promptToMessageText 展开 ```terminal 代码块；isPromptEmpty 含 terminal 不为空 |
| pill DOM 往返 | `composer/editor-sync.ts` 配套测试 | createTerminalPill → parseFromDOM 往返一致；renderPrompt 渲染 terminal 分支 |
| appendTerminalReference | `useComposer` 配套测试 | 追加后 prompt 含 TerminalPart；不影响已有 parts |

### 7.2 集成测试

| 场景 | 验证点 |
|---|---|
| 选区 → Add to Chat → Composer pill | 选区文本 → onAddToChat → Composer 出现 terminal pill |
| 命令块悬停 → Add to Chat → Composer pill | mock onData("ls\r") → 悬停 → onAddToChat 含命令+输出 |
| alternate buffer 跳过 | mock buffer.type='alternate' → onData 不创建块 |
| 选区优先于块 | 有选区时块高亮不显示 |

### 7.3 测试放置

按项目规范，归入已有测试文件：
- composer 类型/pill 测试 → `composer/editor-sync.test.ts`（已存在）
- useComposer 测试 → 查找是否已有 `useComposer.test.ts`，否则附到 `useChat.test.ts` 或新建（注明来源）
- Terminal 组件测试 → 若无 `Terminal.test.tsx`，新建并在注释注明来源

## 8. 不做的事

- **不做** Shell 集成（OSC 133）——输入追踪法已足够，后端零改动
- **不做** 终端右键菜单——选区 + 块悬停已覆盖主要交互
- **不做** 多块批量引用——单次引用一个块或一段选区
- **不做** terminal pill 的 hover tooltip / click 跳转——终端内容无文件路径语义
- **不做** 后端任何改动——纯前端功能

## 9. 文件改动清单

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `composer/types.ts` | 修改 | +TerminalPart，更新 4 个工具函数 |
| `composer/editor-sync.ts` | 修改 | +createTerminalPill，parseFromDOM/renderPrompt 加分支 |
| `composer/useComposer.ts` | 修改 | +appendTerminalReference |
| `composer/Composer.tsx` | 修改 | useEffect 注册 insertTerminalReference |
| `contexts/ReferenceContext.tsx` | 修改 | API 加 insertTerminalReference |
| `components/Terminal.tsx` | 修改（核心） | 选区追踪 + 块追踪 + Add to Chat 按钮 + 块高亮 |
| `components/TerminalPanel.tsx` | 修改 | useFileReference + onAddToChat 回调 |
| 测试文件 | 新增/修改 | 见 §7.3 |
