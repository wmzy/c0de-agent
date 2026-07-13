# 终端「Add to Chat」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户可在终端选中文本或悬停命令块时点击「Add to Chat」，将终端内容以 pill 引用到 Composer，发送时展开为 terminal 代码块。

**Architecture:** 前端输入追踪法识别命令块（onData 追踪回车边界），alternate buffer 检测跳过全屏程序。新增 TerminalPart pill 类型，复用现有 ReferenceContext 跨组件注入 Composer。

**Tech Stack:** React 19, TypeScript, xterm.js (@xterm/xterm), @linaria/core, Vitest, jsdom

**Spec:** `docs/superpowers/specs/2026-07-13-terminal-add-to-chat-design.md`

---

## 文件结构

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/web/composer/types.ts` | Prompt 数据结构 + 工具函数 | 修改：+TerminalPart，更新 4 个工具函数 |
| `src/web/composer/editor-sync.ts` | DOM↔Prompt 双向同步 | 修改：+createTerminalPill，parseFromDOM/renderPrompt 加分支 |
| `src/web/composer/editor-sync.test.ts` | editor-sync 测试 | 修改：+terminal pill 测试 |
| `src/web/composer/useComposer.ts` | Composer 状态 hook | 修改：+appendTerminalReference |
| `src/web/composer/Composer.tsx` | Composer 组件 | 修改：注册 insertTerminalReference |
| `src/web/contexts/ReferenceContext.tsx` | 文件引用跨组件 API | 修改：+insertTerminalReference |
| `src/web/components/Terminal.tsx` | xterm.js 终端渲染组件 | 修改（核心）：选区追踪 + 块追踪 + Add to Chat + 块高亮 |
| `src/web/components/TerminalPanel.tsx` | 终端面板容器 | 修改：useFileReference + onAddToChat 回调 |

---

### Task 1: TerminalPart 类型 + 工具函数

**Files:**
- Modify: `src/web/composer/types.ts`

- [ ] **Step 1: 写失败测试（追加到 editor-sync.test.ts）**

在 `src/web/composer/editor-sync.test.ts` 的 `describe('promptToMessageText')` 块末尾追加：

```typescript
  it('terminal pill 提交时展开为 terminal 代码块', () => {
    const prompt: Prompt = [
      { type: 'text', content: '分析这个 ', start: 0, end: 5 },
      {
        type: 'terminal',
        label: '🖥 命令: npm test',
        content: '$ npm test\n✓ all passed',
        start: 5,
        end: 5 + '🖥 命令: npm test'.length,
      },
    ]
    expect(promptToText(prompt)).toBe('分析这个 🖥 命令: npm test')
    expect(promptToMessageText(prompt)).toBe(
      '分析这个 ```terminal\n$ npm test\n✓ all passed\n```',
    )
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/web/composer/editor-sync.test.ts`
Expected: FAIL — `Type 'terminal' is not assignable` 编译错误（类型不存在）

- [ ] **Step 3: 添加 TerminalPart 类型和更新工具函数**

在 `src/web/composer/types.ts` 中：

在 `SnippetPart` 接口之后添加：

```typescript
/** 终端内容引用 pill：显示标签（如 `🖥 命令: npm test`），
 * 提交时展开为 ```terminal 代码块注入 LLM 上下文。 */
interface TerminalPart extends PartBase {
  type: 'terminal'
  /** pill 显示的标签（= textContent，参与光标定位长度计算）。 */
  label: string
  /** 实际终端文本（选区文本 或 命令+输出），提交时展开为代码块。 */
  content: string
}
```

更新 `ContentPart` union：

```typescript
type ContentPart = TextPart | FilePart | SnippetPart | TerminalPart | ImagePart
```

更新 `export type`：

```typescript
export type { ContentPart, FilePart, ImagePart, PartBase, Prompt, SnippetPart, TerminalPart, TextPart }
```

更新 `promptLength`（terminal 贡献 label 长度）：

```typescript
function promptLength(prompt: Prompt): number {
  return prompt.reduce((len, part) => {
    if (part.type === 'text' || part.type === 'file') return len + part.content.length
    if (part.type === 'snippet') return len + part.label.length
    if (part.type === 'terminal') return len + part.label.length
    return len
  }, 0)
}
```

更新 `promptToText`（terminal 贡献 label 文本）：

```typescript
function promptToText(prompt: Prompt): string {
  return prompt
    .map((p) => {
      if (p.type === 'text' || p.type === 'file') return p.content
      if (p.type === 'snippet') return p.label
      if (p.type === 'terminal') return p.label
      return ''
    })
    .join('')
}
```

更新 `promptToMessageText`（terminal 展开为 ```terminal 代码块）：

```typescript
function promptToMessageText(prompt: Prompt): string {
  return prompt
    .map((p) => {
      if (p.type === 'text' || p.type === 'file') return p.content
      if (p.type === 'snippet') {
        const loc = p.lineStart === p.lineEnd ? `${p.lineStart}` : `${p.lineStart}-${p.lineEnd}`
        return `📄 \`${p.path}:${loc}\`:\n\`\`\`\n${p.snippet}\n\`\`\``
      }
      if (p.type === 'terminal') {
        return `\`\`\`terminal\n${p.content}\n\`\`\``
      }
      return ''
    })
    .join('')
}
```

更新 `isPromptEmpty`（terminal 不算空）：

```typescript
function isPromptEmpty(prompt: Prompt): boolean {
  return (
    promptLength(prompt) === 0 &&
    !prompt.some((p) => p.type === 'file') &&
    !prompt.some((p) => p.type === 'terminal')
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/web/composer/editor-sync.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/web/composer/types.ts src/web/composer/editor-sync.test.ts
git commit -m "feat(composer): 添加 TerminalPart 类型及工具函数"
```

---

### Task 2: editor-sync 支持 terminal pill DOM 往返

**Files:**
- Modify: `src/web/composer/editor-sync.ts`
- Modify: `src/web/composer/editor-sync.test.ts`

- [ ] **Step 1: 写失败测试（追加到 editor-sync.test.ts）**

在 `describe('parseFromDOM')` 块末尾追加：

```typescript
  it('terminal pill 解析为 TerminalPart（含 label/content）', () => {
    const el = makeEditor(
      'x<span data-type="terminal" data-content="$ npm test\n✓ passed">🖥 命令: npm test</span>y',
    )
    const prompt = parseFromDOM(el)
    const terminal = prompt.find((p) => p.type === 'terminal')
    expect(terminal && terminal.type === 'terminal').toBeTruthy()
    if (terminal && terminal.type === 'terminal') {
      expect(terminal.label).toBe('🖥 命令: npm test')
      expect(terminal.content).toBe('$ npm test\n✓ passed')
      expect(terminal.start).toBe(1)
      expect(terminal.end).toBe(1 + '🖥 命令: npm test'.length)
    }
  })
```

在 `describe('renderPrompt')` 块末尾追加：

```typescript
  it('TerminalPart 渲染为带 data 属性的 terminal pill', () => {
    const el = makeEditor('')
    const prompt: Prompt = [
      {
        type: 'terminal',
        label: '🖥 终端选区',
        content: 'hello world',
        start: 0,
        end: 6,
      },
    ]
    renderPrompt(el, prompt)
    const pill = el.querySelector('[data-type="terminal"]')
    expect(pill).toBeTruthy()
    expect(pill?.getAttribute('data-content')).toBe('hello world')
    expect(pill?.textContent).toBe('🖥 终端选区')
    expect(pill?.getAttribute('contenteditable')).toBe('false')
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/web/composer/editor-sync.test.ts`
Expected: FAIL — terminal pill 不被解析（parseFromDOM 找不到 terminal 类型）

- [ ] **Step 3: 添加 createTerminalPill + parseFromDOM/renderPrompt 分支**

在 `src/web/composer/editor-sync.ts` 中：

导入类型更新（在现有 import 旁边添加 `TerminalPart`）：

```typescript
import type { Prompt, SnippetPart, TerminalPart } from './types.js'
```

在 `createSnippetPill` 函数之后添加 `createTerminalPill`：

```typescript
/** 创建 terminal pill 元素（显示 label，content 存 data 属性）。
 * 复用 snippet/file pill 的 pillStyle 样式，但无 hover tooltip / click 跳转。 */
function createTerminalPill(part: TerminalPart): HTMLSpanElement {
  const span = document.createElement('span')
  span.setAttribute('data-type', 'terminal')
  span.setAttribute('data-content', part.content)
  span.setAttribute('contenteditable', 'false')
  span.className = pillStyle
  span.textContent = part.label
  return span
}
```

在 `parseFromDOM` 的 `visit` 函数中，在 `data-type === 'snippet'` 分支之后添加 terminal 分支：

```typescript
    if (el.dataset.type === 'terminal') {
      flushText()
      const label = el.textContent ?? ''
      parts.push({
        type: 'terminal',
        label,
        content: el.dataset.content ?? '',
        start: position,
        end: position + label.length,
      })
      position += label.length
      return
    }
```

在 `renderPrompt` 函数中，在 `part.type === 'snippet'` 分支之后添加：

```typescript
    } else if (part.type === 'terminal') {
      editor.appendChild(createTerminalPill(part))
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/web/composer/editor-sync.test.ts`
Expected: PASS（全部测试通过）

- [ ] **Step 5: 提交**

```bash
git add src/web/composer/editor-sync.ts src/web/composer/editor-sync.test.ts
git commit -m "feat(composer): editor-sync 支持 terminal pill DOM 往返"
```

---

### Task 3: useComposer 添加 appendTerminalReference

**Files:**
- Modify: `src/web/composer/useComposer.ts`

- [ ] **Step 1: 添加 appendTerminalReference 回调**

在 `src/web/composer/useComposer.ts` 中，在 `appendSnippetReference` 之后添加：

```typescript
  /** 外部引用（终端 Add to Chat）：在 prompt 末尾追加 terminal pill。 */
  const appendTerminalReference = useCallback(
    (label: string, content: string) => {
      const prompt = promptRef.current
      const parts: Prompt = []
      for (const part of prompt) {
        if (part.type === 'text') parts.push({ ...part })
        else if (part.type === 'file') parts.push({ ...part })
        else if (part.type === 'snippet') parts.push({ ...part })
        else if (part.type === 'terminal') parts.push({ ...part })
      }
      const text = promptToText(prompt)
      if (text.length > 0 && !text.endsWith(' ')) {
        parts.push({ type: 'text', content: ' ', start: 0, end: 1 })
      }
      parts.push({ type: 'terminal', label, content, start: 0, end: label.length })
      parts.push({ type: 'text', content: ' ', start: 0, end: 1 })
      setPromptExternal(parts, true)
      editorRef.current?.focus()
    },
    [setPromptExternal],
  )
```

在 return 对象中添加 `appendTerminalReference`：

```typescript
  return {
    editorRef,
    composingRef,
    promptRef,
    setPromptExternal,
    images,
    popover,
    popoverQuery,
    showPasteConfirm,
    handleInput,
    handleKeyDown,
    handlePaste,
    confirmPaste,
    cancelPaste,
    addImage,
    removeImage,
    insertSlash,
    insertWorkflow,
    insertFile,
    appendFileReference,
    appendSnippetReference,
    appendTerminalReference,
    send,
    steer,
    setPopover,
    isEmpty,
  }
```

- [ ] **Step 2: 在 Composer.tsx 注册 API**

在 `src/web/composer/Composer.tsx` 中，更新 `useEffect` 注册块（在 `insertSnippetReference` 后添加 `insertTerminalReference`）：

将：

```typescript
    setFileReferenceApi({
      insertFileReference: composer.appendFileReference,
      insertSnippetReference: composer.appendSnippetReference,
    })
```

改为：

```typescript
    setFileReferenceApi({
      insertFileReference: composer.appendFileReference,
      insertSnippetReference: composer.appendSnippetReference,
      insertTerminalReference: composer.appendTerminalReference,
    })
```

更新 deps 数组：

```typescript
  }, [composer.appendFileReference, composer.appendSnippetReference, composer.appendTerminalReference, setFileReferenceApi])
```

- [ ] **Step 3: 类型检查**

Run: `pnpm exec tsc --noEmit -p src/web/tsconfig.json`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add src/web/composer/useComposer.ts src/web/composer/Composer.tsx
git commit -m "feat(composer): 添加 appendTerminalReference + 注册到 ReferenceContext"
```

---

### Task 4: ReferenceContext 添加 insertTerminalReference

**Files:**
- Modify: `src/web/contexts/ReferenceContext.tsx`

- [ ] **Step 1: 更新 FileReferenceAPI 类型**

在 `src/web/contexts/ReferenceContext.tsx` 中，将：

```typescript
export type FileReferenceAPI = {
  insertFileReference: (path: string) => void
  insertSnippetReference: (
    path: string,
    lineStart: number,
    lineEnd: number,
    snippet: string,
  ) => void
}
```

改为：

```typescript
export type FileReferenceAPI = {
  insertFileReference: (path: string) => void
  insertSnippetReference: (
    path: string,
    lineStart: number,
    lineEnd: number,
    snippet: string,
  ) => void
  insertTerminalReference: (label: string, content: string) => void
}
```

- [ ] **Step 2: 类型检查确认一致性**

Run: `pnpm exec tsc --noEmit -p src/web/tsconfig.json`
Expected: 无错误（Composer.tsx 在 Task 3 已传入 insertTerminalReference，类型现已匹配）

- [ ] **Step 3: 提交**

```bash
git add src/web/contexts/ReferenceContext.tsx
git commit -m "feat(context): ReferenceContext 添加 insertTerminalReference"
```

---

### Task 5: Terminal.tsx 命令块追踪 + 选区 + Add to Chat 按钮（核心）

**Files:**
- Modify: `src/web/components/Terminal.tsx`

这是最大的改动。Terminal 组件从纯渲染桥接扩展为支持选区引用和命令块识别的交互组件。

- [ ] **Step 1: 添加 onAddToChat prop 和追踪基础设施**

在 `src/web/components/Terminal.tsx` 中，更新 import 和 interface：

```typescript
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { css } from '@linaria/core'
```

更新 props interface：

```typescript
interface TerminalProps {
  /** WebSocket 连接（由 useTerminal hook 管理）。 */
  ws: WebSocket | null
  /** 终端可见时为 true（隐藏时暂停 fit 计算）。 */
  visible: boolean
  /** 终端尺寸变化时通知后端（cols, rows）。 */
  onResize?: (cols: number, rows: number) => void
  /** 终端 Add to Chat 回调（选区或命令块引用）。 */
  onAddToChat?: (label: string, content: string) => void
}
```

添加样式（在文件顶部 css import 附近）：

```typescript
const addToChatBtnStyle = css`
  position: absolute;
  top: 4px;
  left: 8px;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--text);
  background: var(--bg-secondary, #1c2128);
  border: 1px solid var(--primary, #4a9eff);
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: background 0.12s;

  &:hover {
    background: var(--primary, #4a9eff);
    color: #fff;
  }
`

const blockHighlightStyle = css`
  position: absolute;
  left: 0;
  right: 0;
  z-index: 5;
  background: rgba(74, 158, 255, 0.08);
  border-left: 2px solid var(--primary, #4a9eff);
  pointer-events: none;
`
```

添加命令块类型（在 interface 之后）：

```typescript
/** 命令块：一个用户命令及其输出的行范围。 */
interface CommandBlock {
  /** 终端绝对行号（baseY + cursorY），稳定标识。 */
  startRow: number
  /** 命令文本（用户输入）。 */
  command: string
}
```

- [ ] **Step 2: 实现块追踪 + 选区 + Add to Chat 逻辑**

在 Terminal 组件函数体内（在现有 refs 声明之后）添加状态和逻辑：

```typescript
export function Terminal({ ws, visible, onResize, onAddToChat }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  // 命令块追踪状态
  const blocksRef = useRef<CommandBlock[]>([])
  const currentInputRef = useRef('')
  const wasAlternateRef = useRef(false)
  // 选区 + 块悬停状态
  const [selection, setSelection] = useState<string | null>(null)
  const [hoverBlock, setHoverBlock] = useState<{ top: number; height: number; block: CommandBlock } | null>(null)
```

在初始化 xterm 的 useEffect 内（`term.open(containerRef.current)` 之后），添加选区和块追踪回调注册：

```typescript
    // 选区变化追踪
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      setSelection(sel && sel.length > 0 ? sel : null)
    })
```

在桥接 WebSocket 的 useEffect 内，更新 `onTermData` 回调以追踪命令块：

将现有的：

```typescript
    // xterm 输入 → WS
    const onTermData = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    }
```

改为：

```typescript
    // xterm 输入 → WS + 命令块追踪
    const onTermData = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
      // 命令块追踪：跳过 alternate buffer（vim/less/top 等全屏程序）
      const isAlt = term.buffer.active.type === 'alternate'
      if (isAlt) {
        wasAlternateRef.current = true
        currentInputRef.current = ''
        return
      }
      // 从 alternate 切回 normal 时清空输入缓存
      if (wasAlternateRef.current) {
        wasAlternateRef.current = false
        currentInputRef.current = ''
      }
      for (const char of data) {
        if (char === '\r') {
          const absRow = term.buffer.active.baseY + term.buffer.active.cursorY
          blocksRef.current.push({
            startRow: absRow,
            command: currentInputRef.current,
          })
          // 修剪被 scrollback 裁掉的旧块
          const maxRow = term.buffer.active.length
          blocksRef.current = blocksRef.current.filter((b) => b.startRow <= maxRow)
          currentInputRef.current = ''
        } else if (char >= ' ') {
          // 可打印字符累积到当前输入（跳过控制字符）
          currentInputRef.current += char
        }
      }
    }
```

- [ ] **Step 3: 实现鼠标悬停→块高亮 + Add to Chat 点击**

在 Terminal 组件函数体内添加 mousemove 处理和点击处理（在所有 useEffect 之后、return 之前）：

```typescript
  /** 鼠标悬停时计算命令块高亮。 */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // 有选区时不显示块高亮
      if (selection) {
        if (hoverBlock) setHoverBlock(null)
        return
      }
      const term = termRef.current
      const container = containerRef.current
      if (!term || !container) return
      // 仅 normal buffer 追踪块
      if (term.buffer.active.type === 'alternate') {
        if (hoverBlock) setHoverBlock(null)
        return
      }
      const rect = container.getBoundingClientRect()
      const cellHeight = rect.height / term.rows
      const row = Math.floor((e.clientY - rect.top) / cellHeight)
      const absRow = term.buffer.active.baseY + row

      // 查找 absRow 所在的块
      const blocks = blocksRef.current
      let foundIdx = -1
      for (let i = 0; i < blocks.length; i++) {
        const endRow = blocks[i + 1]?.startRow ?? Infinity
        if (absRow >= blocks[i]!.startRow && absRow < endRow) {
          foundIdx = i
          break
        }
      }
      if (foundIdx === -1) {
        if (hoverBlock) setHoverBlock(null)
        return
      }
      // 计算块在视口内的像素范围
      const block = blocks[foundIdx]!
      const nextStart = blocks[foundIdx + 1]?.startRow ?? term.buffer.active.baseY + term.rows
      const startViewportRow = block.startRow - term.buffer.active.baseY
      const endViewportRow = nextStart - term.buffer.active.baseY
      const top = Math.max(0, startViewportRow) * cellHeight
      const bottom = Math.min(term.rows, endViewportRow) * cellHeight
      const height = bottom - top
      if (height <= 0) {
        if (hoverBlock) setHoverBlock(null)
        return
      }
      setHoverBlock({ top, height, block })
    },
    [selection, hoverBlock],
  )

  /** 鼠标离开时清除块高亮。 */
  const handleMouseLeave = useCallback(() => {
    if (hoverBlock) setHoverBlock(null)
  }, [hoverBlock])

  /** 从终端 buffer 提取命令块文本。 */
  const extractBlockText = useCallback(
    (block: CommandBlock): string => {
      const term = termRef.current
      if (!term) return block.command
      const blocks = blocksRef.current
      const idx = blocks.indexOf(block)
      const endRow = blocks[idx + 1]?.startRow ?? term.buffer.active.baseY + term.buffer.active.cursorY
      const lines: string[] = []
      for (let i = block.startRow; i <= endRow && i < term.buffer.active.length; i++) {
        const line = term.buffer.active.getLine(i)
        if (line) lines.push(line.translateToString(true))
      }
      return lines.join('\n').replace(/\n+$/, '')
    },
    [],
  )

  /** Add to Chat 按钮点击。 */
  const handleAddToChat = useCallback(() => {
    if (selection) {
      onAddToChat?.('🖥 终端选区', selection)
      // 引用后清除选区
      termRef.current?.clearSelection()
      setSelection(null)
    } else if (hoverBlock) {
      const content = extractBlockText(hoverBlock.block)
      const cmd = hoverBlock.block.command.trim()
      const label = cmd
        ? `🖥 命令: ${cmd.length > 30 ? `${cmd.slice(0, 30)}…` : cmd}`
        : '🖥 终端输出'
      onAddToChat?.(label, content)
    }
  }, [selection, hoverBlock, extractBlockText, onAddToChat])
```

- [ ] **Step 4: 更新 return JSX 渲染按钮和高亮**

将现有的 return：

```tsx
  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        padding: '4px 8px',
        overflow: 'hidden',
      }}
    />
  )
```

改为：

```tsx
  const showAddToChat = onAddToChat && (selection || hoverBlock)

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        padding: '4px 8px',
        overflow: 'hidden',
        position: 'relative',
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {showAddToChat && (
        <button
          className={addToChatBtnStyle}
          onClick={handleAddToChat}
          type="button"
          aria-label="添加到会话"
        >
          ＋ Add to Chat
        </button>
      )}
      {!selection && hoverBlock && (
        <div
          className={blockHighlightStyle}
          style={{ top: hoverBlock.top, height: hoverBlock.height }}
        />
      )}
    </div>
  )
```

- [ ] **Step 5: 类型检查 + 现有测试不回归**

Run: `pnpm exec tsc --noEmit -p src/web/tsconfig.json`
Expected: 无错误

Run: `pnpm exec vitest run src/web/hooks/useTerminal.test.ts`
Expected: PASS（现有终端测试不回归）

- [ ] **Step 6: 提交**

```bash
git add src/web/components/Terminal.tsx
git commit -m "feat(terminal): 命令块追踪 + 选区引用 + Add to Chat 按钮"
```

---

### Task 6: TerminalPanel 接线 onAddToChat

**Files:**
- Modify: `src/web/components/TerminalPanel.tsx`

- [ ] **Step 1: 在 PaneSplitContainer 中接线 useFileReference**

在 `src/web/components/TerminalPanel.tsx` 顶部添加 import：

```typescript
import { useFileReference } from '../contexts/ReferenceContext.js'
```

在 `PaneSplitContainer` 组件函数体内添加：

```typescript
function PaneSplitContainer({
  tab,
  activePaneId,
  getWebSocket,
  visible,
  onPaneResize,
  onPaneClick,
  onPaneClose,
  onDividerPointerDown,
}: {
  tab: NonNullable<UseTerminalReturn['tabs'][number]>
  activePaneId: string | null
  getWebSocket: (id: string) => WebSocket | null
  visible: boolean
  onPaneResize: (id: string, cols: number, rows: number) => void
  onPaneClick: (id: string) => void
  onPaneClose: (id: string) => void
  onDividerPointerDown: (e: React.PointerEvent<HTMLElement>, tabId: string, leftIdx: number, direction: SplitDirection) => void
}) {
  const fileRef = useFileReference()

  const handleAddToChat = useCallback((label: string, content: string) => {
    fileRef?.insertTerminalReference(label, content)
  }, [fileRef])
```

（确保 `useCallback` 已在 import 中，现有文件已 import `useCallback`。）

- [ ] **Step 2: 将 onAddToChat 传给 Terminal**

在 `PaneSplitContainer` 的 render 中，找到 `<Terminal` 标签，添加 `onAddToChat` prop：

将：

```tsx
              <Terminal
                ws={getWebSocket(pane.id)}
                visible={visible}
                onResize={(cols, rows) => onPaneResize(pane.id, cols, rows)}
              />
```

改为：

```tsx
              <Terminal
                ws={getWebSocket(pane.id)}
                visible={visible}
                onResize={(cols, rows) => onPaneResize(pane.id, cols, rows)}
                onAddToChat={handleAddToChat}
              />
```

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `pnpm exec tsc --noEmit -p src/web/tsconfig.json`
Expected: 无错误

Run: `pnpm exec vitest run src/web/`
Expected: 全部 PASS（现有测试不回归）

- [ ] **Step 4: 提交**

```bash
git add src/web/components/TerminalPanel.tsx
git commit -m "feat(terminal): TerminalPanel 接线 Add to Chat 到 Composer"
```

---

### Task 7: 构建验证 + Biome lint

**Files:** 无文件改动，纯验证

- [ ] **Step 1: Biome lint/format 检查**

Run: `pnpm exec biome check src/web/composer/types.ts src/web/composer/editor-sync.ts src/web/composer/useComposer.ts src/web/composer/Composer.tsx src/web/contexts/ReferenceContext.tsx src/web/components/Terminal.tsx src/web/components/TerminalPanel.tsx`
Expected: 无错误（如有 format 问题，`pnpm exec biome check --write` 修复）

- [ ] **Step 2: 全量测试**

Run: `pnpm exec vitest run src/web/`
Expected: 全部 PASS

- [ ] **Step 3: 生产构建**

Run: `pnpm run build`
Expected: 构建成功，无类型错误

- [ ] **Step 4: 提交（如有 lint 修复）**

```bash
git add -A
git commit -m "chore: lint + format 修复" || echo "无改动需要提交"
```
