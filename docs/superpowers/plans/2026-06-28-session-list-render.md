# 会话列表式渲染（对齐 opencode）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Web 端会话渲染从「气泡式」改造为 opencode 风格的「列表式」——每个消息 part 独立成块、左侧 icon+timeline 装饰栏、右侧内容区，并为 read/write/edit/bash/grep/glob 六个工具实现专用渲染器。

**Architecture:** 纯前端改造，不动后端 schema / AgentEvent 契约。核心是 `normalizeParts` 纯函数把 message content 归并为渲染块（按 id 合并 tool_call + tool_result），再由 `MessageItem` 列表式渲染、`ToolBlock` 按工具名分发到专用渲染器。沿用 Linaria + 现有 CSS 变量 + marked/shiki。

**Tech Stack:** React 19、TypeScript、Linaria（CSS-in-JS）、marked + shiki（已有）、`diff`（新增，用于 edit 行级 diff）、vitest + @testing-library/react（测试）。

**关键约束（实现前必读）：**
- `tool_result.tool` 在流式累积（`src/web/hooks/useChat.ts` 的 `reduceChatEvent`）时被设为**空字符串**。因此 `normalizeParts` 合并时必须以 `tool_call.tool` 为准，按 `id` 匹配 result。
- `highlightCode(code, lang)`（`src/web/utils/highlight.ts`）仅加载 15 种语言，未加载的 lang 会回退到 `typescript`。对未知扩展名文件应走纯 `<pre>`，避免误染色。
- bash 成功时 `exitCode` 在 `output.metadata.exitCode`；失败时是 `_tag:'error'`，error 字符串含 exit code。
- 测试放置遵循 AGENTS.md：复用现有文件优先，纯逻辑无归属才新建。命令：`pnpm test <file>`、`pnpm run typecheck:web`、`pnpm run lint`。

**设计依据：** `docs/superpowers/specs/2026-06-28-session-list-render-design.md`

---

## Task 1: 新增 diff 依赖

**Files:**
- Modify: `package.json`（dependencies 增加 `diff`）

- [ ] **Step 1: 添加 diff 依赖**

运行：
```bash
pnpm add diff && pnpm add -D @types/diff
```

- [ ] **Step 2: 验证依赖写入**

运行：`grep '"diff"' package.json`
Expected: 出现 `"diff": "^..."`（dependencies）与 `"@types/diff"`（devDependencies）。

- [ ] **Step 3: 验证 import 可用**

运行（临时验证，不落盘）：
```bash
node -e "import('diff').then(m => console.log(typeof m.diffLines))"
```
Expected: `function`

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "deps: add diff for edit tool line-level diff rendering"
```

---

## Task 2: normalizeParts 纯函数（TDD）

把 message content 归并为渲染块；按 id 合并 tool_call + tool_result。

**Files:**
- Create: `src/web/components/session/utils/normalizeParts.ts`
- Test: `src/web/components/session/utils/normalizeParts.test.ts`

- [ ] **Step 1: 写失败测试**

`src/web/components/session/utils/normalizeParts.test.ts`：
```ts
import type { Message, MessageContent } from '@shared/types/message.js'
import { describe, expect, it } from 'vitest'
import { normalizeParts } from './normalizeParts.js'

function msg(role: Message['role'], parts: MessageContent[]): Message {
  return { id: '1', sessionId: 's', role, content: parts, tokenCount: 0, createdAt: 1 }
}

describe('normalizeParts', () => {
  it('纯文本消息映射为 text 块', () => {
    const blocks = normalizeParts(msg('user', [{ _tag: 'text', text: 'hi' }]))
    expect(blocks).toEqual([{ type: 'text', role: 'user', text: 'hi' }])
  })

  it('thinking 映射为 thinking 块', () => {
    const blocks = normalizeParts(msg('assistant', [{ _tag: 'thinking', text: 'hmm' }]))
    expect(blocks).toEqual([{ type: 'thinking', text: 'hmm' }])
  })

  it('steering 映射为 steering 块', () => {
    const blocks = normalizeParts(msg('user', [{ _tag: 'steering', text: 's' }]))
    expect(blocks).toEqual([{ type: 'steering', text: 's' }])
  })

  it('tool_call + 同 id tool_result(success) 合并为 completed', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 't1', tool: 'read', input: { path: 'a.ts' } },
        { _tag: 'tool_result', id: 't1', tool: '', output: { _tag: 'success', output: 'x' } },
      ]),
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'tool',
      id: 't1',
      tool: 'read',
      input: { path: 'a.ts' },
      status: 'completed',
    })
  })

  it('tool_result(error) → error 状态', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 't2', tool: 'bash', input: { command: 'ls' } },
        { _tag: 'tool_result', id: 't2', tool: '', output: { _tag: 'error', error: 'boom' } },
      ]),
    )
    expect(blocks[0]).toMatchObject({ status: 'error' })
  })

  it('tool_result(permission_required) → paused 状态', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 't3', tool: 'edit', input: {} },
        { _tag: 'tool_result', id: 't3', tool: '', output: { _tag: 'permission_required', reason: 'r' } },
      ]),
    )
    expect(blocks[0]).toMatchObject({ status: 'paused' })
  })

  it('truncated 结果也算 completed', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_call', id: 't4', tool: 'grep', input: {} },
        {
          _tag: 'tool_result',
          id: 't4',
          tool: '',
          output: { _tag: 'truncated', output: 'o', truncated: true, totalLines: 100 },
        },
      ]),
    )
    expect(blocks[0]).toMatchObject({ status: 'completed' })
  })

  it('仅有 tool_call 无 result → running 状态', () => {
    const blocks = normalizeParts(
      msg('assistant', [{ _tag: 'tool_call', id: 't5', tool: 'read', input: {} }]),
    )
    expect(blocks[0]).toMatchObject({ status: 'running' })
  })

  it('孤立的 tool_result（无对应 call）仍渲染为 tool 块', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'tool_result', id: 't6', tool: 'glob', output: { _tag: 'success', output: 'f.ts' } },
      ]),
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'tool', id: 't6', tool: 'glob', status: 'completed' })
  })

  it('混合多 part 保持顺序', () => {
    const blocks = normalizeParts(
      msg('assistant', [
        { _tag: 'text', text: 'a' },
        { _tag: 'tool_call', id: 't7', tool: 'read', input: {} },
        { _tag: 'tool_result', id: 't7', tool: '', output: { _tag: 'success', output: 'r' } },
        { _tag: 'text', text: 'b' },
      ]),
    )
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool', 'text'])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/web/components/session/utils/normalizeParts.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/web/components/session/utils/normalizeParts.ts`：
```ts
import type { Message, MessageRole } from '@shared/types/message.js'
import type { ToolResult } from '@shared/types/tool.js'

/** normalizeParts 产出的渲染块。 */
export type RenderBlock =
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

type ToolBlock = Extract<RenderBlock, { type: 'tool' }>

/** 把 message.content 归并为渲染块；按 id 合并 tool_call + tool_result。 */
export function normalizeParts(message: Message): RenderBlock[] {
  const blocks: RenderBlock[] = []
  const toolIndex = new Map<string, number>()

  for (const part of message.content) {
    switch (part._tag) {
      case 'text':
        blocks.push({ type: 'text', role: message.role, text: part.text })
        break
      case 'thinking':
        blocks.push({ type: 'thinking', text: part.text })
        break
      case 'steering':
        blocks.push({ type: 'steering', text: part.text })
        break
      case 'tool_call': {
        const tb: ToolBlock = {
          type: 'tool',
          id: part.id,
          tool: part.tool,
          input: part.input,
          status: 'running',
        }
        toolIndex.set(part.id, blocks.length)
        blocks.push(tb)
        break
      }
      case 'tool_result': {
        const status = resultStatus(part.output)
        const idx = toolIndex.get(part.id)
        if (idx !== undefined) {
          const tb = blocks[idx] as ToolBlock
          tb.status = status
          tb.output = part.output
          if (!tb.tool) tb.tool = part.tool || 'tool'
        } else {
          blocks.push({
            type: 'tool',
            id: part.id,
            tool: part.tool || 'tool',
            input: null,
            status,
            output: part.output,
          })
        }
        break
      }
    }
  }
  return blocks
}

function resultStatus(output: ToolResult): 'completed' | 'error' | 'paused' {
  switch (output._tag) {
    case 'success':
    case 'truncated':
      return 'completed'
    case 'error':
      return 'error'
    case 'permission_required':
      return 'paused'
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/web/components/session/utils/normalizeParts.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add src/web/components/session/utils/normalizeParts.ts src/web/components/session/utils/normalizeParts.test.ts
git commit -m "feat(web): add normalizeParts to merge tool_call/tool_result into render blocks"
```

---

## Task 3: useOverflow hook 与 CopyButton（TDD）

通用机制：溢出折叠、复制按钮。

**Files:**
- Create: `src/web/components/session/hooks/useOverflow.ts`
- Create: `src/web/components/CopyButton.tsx`
- Test: `src/web/components/CopyButton.test.tsx`

- [ ] **Step 1: 实现 useOverflow**

`src/web/components/session/hooks/useOverflow.ts`：
```ts
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 检测内容是否溢出阈值（像素），并提供展开/收起态。
 * 用法：把 ref 绑到内容容器，用 expanded 控制 max-height（CSS 侧）。
 */
export function useOverflow(threshold = 300) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setOverflowing(el.scrollHeight > threshold)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [threshold])

  const toggle = useCallback(() => setExpanded((v) => !v), [])
  return { ref, overflowing, expanded, toggle }
}
```

- [ ] **Step 2: 写 CopyButton 失败测试**

`src/web/components/CopyButton.test.tsx`：
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CopyButton } from './CopyButton.js'

describe('CopyButton', () => {
  it('点击后调用 clipboard 并切换为已复制', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<CopyButton text="abc" />)
    await userEvent.click(screen.getByTestId('copy-button'))
    expect(writeText).toHaveBeenCalledWith('abc')
    expect(screen.getByTestId('copy-button')).toHaveTextContent('已复制')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test src/web/components/CopyButton.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 CopyButton**

`src/web/components/CopyButton.tsx`：
```tsx
import { css } from '@linaria/core'
import { useState } from 'react'

const btn = css`
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  &:hover {
    color: var(--text);
  }
`

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const onClick = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <button type="button" className={btn} onClick={onClick} data-testid="copy-button">
      {copied ? '已复制' : label}
    </button>
  )
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test src/web/components/CopyButton.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/components/session/hooks/useOverflow.ts src/web/components/CopyButton.tsx src/web/components/CopyButton.test.tsx
git commit -m "feat(web): add useOverflow hook and CopyButton"
```

---

## Task 4: theme diff 变量、extToLang、icon 组件

基础设施：diff 语义色变量、文件扩展名→语言映射、内联 SVG icon。

**Files:**
- Modify: `src/web/styles/theme.ts`
- Create: `src/web/components/session/utils/lang.ts`
- Create: `src/web/components/session/icons.tsx`

- [ ] **Step 1: 扩展 theme.ts diff 变量**

在 `src/web/styles/theme.ts` 的 `themeVars` 中，`:global(:root)` 块末尾（`--shadow: ...;` 之后）与 `.dark` 块末尾分别追加 diff 变量：

`:global(:root)` 追加：
```css
    --diff-add-bg: #e6ffec;
    --diff-add-text: #1a7f37;
    --diff-del-bg: #ffebe9;
    --diff-del-text: #cf222e;
```
`:global(.dark)` 追加：
```css
    --diff-add-bg: #0d2818;
    --diff-add-text: #3fb950;
    --diff-del-bg: #2d0a0a;
    --diff-del-text: #f85149;
```

- [ ] **Step 2: 实现 extToLang**

`src/web/components/session/utils/lang.ts`：
```ts
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  html: 'html', htm: 'html', xml: 'html',
  css: 'css', scss: 'css', less: 'css',
  json: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown', markdown: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql',
}

/** 文件扩展名 → shiki 语言；未知返回 'text'。 */
export function extToLang(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return EXT_LANG[ext] ?? 'text'
}
```

- [ ] **Step 3: 实现 icon 组件**

`src/web/components/session/icons.tsx`：
```tsx
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base(props: IconProps) {
  const { size = 16, ...rest } = props
  return { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, ...rest }
}

export function UserIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5" />
    </svg>
  )
}

export function SparkleIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5L8 2z" />
    </svg>
  )
}

export function BrainIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M8 3a2.5 2.5 0 00-2.5 2.5v5A2.5 2.5 0 0010 13V5.5" />
      <path d="M10.5 5.5A2.5 2.5 0 0113 8a2.5 2.5 0 01-1 2 2.5 2.5 0 01-1 2" />
    </svg>
  )
}

export function ReadIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3 2.5h6l4 4v7a1 1 0 01-1 1H3a1 1 0 01-1-1v-9a1 1 0 011-1z" />
      <path d="M9 2.5v4h4" />
    </svg>
  )
}

export function WriteIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3 2.5h6l4 4v7a1 1 0 01-1 1H3a1 1 0 01-1-1v-9a1 1 0 011-1z" />
      <path d="M9 2.5v4h4M5.5 10h5M5.5 12h3" />
    </svg>
  )
}

export function EditIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M11.5 2.5l2 2L6 12H4v-2l9.5-9.5z" />
    </svg>
  )
}

export function BashIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 7l2 1.5L5 10M9 10h2.5" />
    </svg>
  )
}

export function GrepIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </svg>
  )
}

export function GlobIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
      <circle cx="8" cy="8" r="6" />
    </svg>
  )
}

export function ToolIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M10.5 3.5a2 2 0 012.8 2.8L8 11.6 5 12.5 5.9 9.5l4.6-6z" />
    </svg>
  )
}
```

- [ ] **Step 4: 验证 typecheck**

Run: `pnpm run typecheck:web`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/web/styles/theme.ts src/web/components/session/utils/lang.ts src/web/components/session/icons.tsx
git commit -m "feat(web): add diff theme vars, extToLang mapping, and session icons"
```

---

## Task 5: PartDecoration 组件（TDD）

左侧装饰栏：icon（按 role+type+tool 分发）+ timeline 竖线。

**Files:**
- Create: `src/web/components/session/PartDecoration.tsx`
- Test: `src/web/components/session/PartDecoration.test.tsx`

- [ ] **Step 1: 写失败测试**

`src/web/components/session/PartDecoration.test.tsx`：
```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PartDecoration } from './PartDecoration.js'
import type { RenderBlock } from './utils/normalizeParts.js'

describe('PartDecoration', () => {
  it('user text 显示用户 icon', () => {
    const block: RenderBlock = { type: 'text', role: 'user', text: 'hi' }
    render(<PartDecoration block={block} />)
    expect(screen.getByTestId('decoration').getAttribute('data-icon')).toBe('user')
  })

  it('assistant text 显示 sparkle icon', () => {
    const block: RenderBlock = { type: 'text', role: 'assistant', text: 'hi' }
    render(<PartDecoration block={block} />)
    expect(screen.getByTestId('decoration').getAttribute('data-icon')).toBe('assistant')
  })

  it('thinking 显示 brain icon', () => {
    const block: RenderBlock = { type: 'thinking', text: 'hmm' }
    render(<PartDecoration block={block} />)
    expect(screen.getByTestId('decoration').getAttribute('data-icon')).toBe('brain')
  })

  it('tool 块按工具名显示对应 icon', () => {
    const block: RenderBlock = {
      type: 'tool', id: '1', tool: 'bash', input: {}, status: 'completed',
    }
    render(<PartDecoration block={block} />)
    expect(screen.getByTestId('decoration').getAttribute('data-icon')).toBe('bash')
  })

  it('未知工具显示通用 tool icon', () => {
    const block: RenderBlock = {
      type: 'tool', id: '1', tool: 'custom', input: {}, status: 'running',
    }
    render(<PartDecoration block={block} />)
    expect(screen.getByTestId('decoration').getAttribute('data-icon')).toBe('tool')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/web/components/session/PartDecoration.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/web/components/session/PartDecoration.tsx`：
```tsx
import { css } from '@linaria/core'
import type { RenderBlock } from './utils/normalizeParts.js'
import {
  BashIcon, BrainIcon, EditIcon, GlobIcon, GrepIcon, ReadIcon, SparkleIcon, ToolIcon, UserIcon, WriteIcon,
} from './icons.js'

const wrap = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 28px;
  flex-shrink: 0;
  color: var(--text-secondary);
`

const iconWrap = css`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 24px;
`

const bar = css`
  flex: 1;
  width: 2px;
  min-height: 8px;
  margin-top: 2px;
  background: var(--border);
`

const TOOL_ICONS: Record<string, typeof ReadIcon> = {
  read: ReadIcon,
  write: WriteIcon,
  edit: EditIcon,
  bash: BashIcon,
  grep: GrepIcon,
  glob: GlobIcon,
}

export function PartDecoration({ block }: { block: RenderBlock }) {
  let iconName: string
  let icon: React.ReactNode
  switch (block.type) {
    case 'text':
      if (block.role === 'user') {
        iconName = 'user'
        icon = <UserIcon />
      } else {
        iconName = 'assistant'
        icon = <SparkleIcon />
      }
      break
    case 'thinking':
      iconName = 'brain'
      icon = <BrainIcon />
      break
    case 'steering':
      iconName = 'user'
      icon = <UserIcon />
      break
    case 'tool': {
      iconName = TOOL_ICONS[block.tool] ? block.tool : 'tool'
      const Icon = TOOL_ICONS[block.tool] ?? ToolIcon
      icon = <Icon />
      break
    }
  }
  return (
    <div className={wrap} data-testid="decoration" data-icon={iconName}>
      <div className={iconWrap}>{icon}</div>
      <div className={bar} />
    </div>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/web/components/session/PartDecoration.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/components/session/PartDecoration.tsx src/web/components/session/PartDecoration.test.tsx
git commit -m "feat(web): add PartDecoration with icon dispatch and timeline bar"
```

---

## Task 6: UserTextBlock、AssistantTextBlock、ReasoningBlock（TDD）

文本类内容块：用户文本（溢出折叠）、助手文本（markdown+复制+溢出折叠+完成时间）、思考块（可折叠）。

**Files:**
- Create: `src/web/components/session/UserTextBlock.tsx`
- Create: `src/web/components/session/AssistantTextBlock.tsx`
- Create: `src/web/components/session/ReasoningBlock.tsx`
- Test: `src/web/components/session/text-blocks.test.tsx`

- [ ] **Step 1: 写失败测试**

`src/web/components/session/text-blocks.test.tsx`：
```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AssistantTextBlock } from './AssistantTextBlock.js'
import { ReasoningBlock } from './ReasoningBlock.js'
import { UserTextBlock } from './UserTextBlock.js'

describe('UserTextBlock', () => {
  it('渲染文本', () => {
    render(<UserTextBlock text="hello" />)
    expect(screen.getByTestId('user-text')).toHaveTextContent('hello')
  })
})

describe('AssistantTextBlock', () => {
  it('渲染内容并带复制按钮', () => {
    render(<AssistantTextBlock text="**bold**" />)
    expect(screen.getByTestId('assistant-text')).toBeInTheDocument()
    expect(screen.getByTestId('copy-button')).toBeInTheDocument()
  })

  it('有 completedAt 时显示时间', () => {
    render(<AssistantTextBlock text="hi" completedAt={1700000000000} />)
    expect(screen.getByTestId('assistant-time')).toBeInTheDocument()
  })
})

describe('ReasoningBlock', () => {
  it('默认折叠，点击展开', () => {
    render(<ReasoningBlock text="thinking" />)
    expect(screen.getByTestId('reasoning').getAttribute('data-expanded')).toBe('false')
    screen.getByTestId('reasoning-toggle').click()
    expect(screen.getByTestId('reasoning').getAttribute('data-expanded')).toBe('true')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/web/components/session/text-blocks.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 UserTextBlock**

`src/web/components/session/UserTextBlock.tsx`：
```tsx
import { css } from '@linaria/core'
import { useOverflow } from './hooks/useOverflow.js'

const wrap = css`
  display: flex;
  flex-direction: column;
`

const text = css`
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.5;
`

const collapsed = css`
  max-height: 300px;
  overflow: hidden;
`

const btn = css`
  align-self: flex-start;
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 0;
`

export function UserTextBlock({ text: content }: { text: string }) {
  const { ref, overflowing, expanded, toggle } = useOverflow()
  const showToggle = overflowing && !expanded
  return (
    <div className={wrap} data-testid="user-text">
      <pre ref={ref} className={`${text} ${showToggle ? collapsed : ''}`}>
        {content}
      </pre>
      {overflowing && (
        <button type="button" className={btn} onClick={toggle}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 实现 AssistantTextBlock**

`src/web/components/session/AssistantTextBlock.tsx`：
```tsx
import { css } from '@linaria/core'
import { CopyButton } from '../CopyButton.js'
import { useOverflow } from './hooks/useOverflow.js'
import { Markdown } from '../Markdown.js'

const wrap = css`
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const body = css`
  font-size: 14px;
  line-height: 1.6;

  & pre {
    max-height: 300px;
    overflow: auto;
  }
`

const collapsed = css`
  max-height: 400px;
  overflow: hidden;
`

const btn = css`
  align-self: flex-start;
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

const footer = css`
  font-size: 12px;
  color: var(--text-secondary);
`

export function AssistantTextBlock({ text, completedAt }: { text: string; completedAt?: number }) {
  const { ref, overflowing, expanded, toggle } = useOverflow(400)
  const showToggle = overflowing && !expanded
  return (
    <div className={wrap} data-testid="assistant-text">
      <div ref={ref} className={`${body} ${showToggle ? collapsed : ''}`}>
        <Markdown content={text} />
      </div>
      {overflowing && (
        <button type="button" className={btn} onClick={toggle}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <CopyButton text={text} />
        {completedAt && (
          <span className={footer} data-testid="assistant-time">
            {new Date(completedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: 实现 ReasoningBlock**

`src/web/components/session/ReasoningBlock.tsx`：
```tsx
import { css } from '@linaria/core'
import { useState } from 'react'
import { Markdown } from '../Markdown.js'

const wrap = css`
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
`

const header = css`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  background: var(--bg-secondary);
  font-size: 13px;
  color: var(--text-secondary);
`

const body = css`
  padding: 8px 12px;
  font-size: 13px;
`

export function ReasoningBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={wrap} data-testid="reasoning" data-expanded={expanded}>
      <button
        type="button"
        className={header}
        data-testid="reasoning-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span>思考过程</span>
      </button>
      {expanded && (
        <div className={body}>
          <Markdown content={text} />
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test src/web/components/session/text-blocks.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/web/components/session/UserTextBlock.tsx src/web/components/session/AssistantTextBlock.tsx src/web/components/session/ReasoningBlock.tsx src/web/components/session/text-blocks.test.tsx
git commit -m "feat(web): add UserTextBlock, AssistantTextBlock, ReasoningBlock"
```

---

## Task 7: ContentDiff 子组件（TDD）

edit 工具用的行级 diff：oldText/newText 对比，+/- 行着色。

**Files:**
- Create: `src/web/components/session/ContentDiff.tsx`
- Test: `src/web/components/session/ContentDiff.test.tsx`

- [ ] **Step 1: 写失败测试**

`src/web/components/session/ContentDiff.test.tsx`：
```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ContentDiff } from './ContentDiff.js'

describe('ContentDiff', () => {
  it('渲染新增行（added）', () => {
    render(<ContentDiff oldText="a" newText={'a\nb'} />)
    const rows = screen.getByTestId('diff').querySelectorAll('[data-diff]')
    const added = Array.from(rows).filter((r) => r.getAttribute('data-diff') === 'added')
    expect(added.length).toBe(1)
    expect(added[0]).toHaveTextContent('b')
  })

  it('渲染删除行（removed）', () => {
    render(<ContentDiff oldText={'a\nb'} newText="a" />)
    const rows = screen.getByTestId('diff').querySelectorAll('[data-diff]')
    const removed = Array.from(rows).filter((r) => r.getAttribute('data-diff') === 'removed')
    expect(removed.length).toBe(1)
    expect(removed[0]).toHaveTextContent('b')
  })

  it('渲染未变行（unchanged）', () => {
    render(<ContentDiff oldText={'a\nb'} newText={'a\nb'} />)
    const rows = screen.getByTestId('diff').querySelectorAll('[data-diff]')
    const unchanged = Array.from(rows).filter((r) => r.getAttribute('data-diff') === 'unchanged')
    expect(unchanged.length).toBe(2)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/web/components/session/ContentDiff.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/web/components/session/ContentDiff.tsx`：
```tsx
import { css } from '@linaria/core'
import { diffLines } from 'diff'

const wrap = css`
  margin: 4px 0;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  font-size: 13px;
`

const row = css`
  display: flex;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 0 8px;
  line-height: 1.5;
  font-family: 'SFMono-Regular', Consolas, monospace;
`

const marker = css`
  width: 16px;
  flex-shrink: 0;
  color: var(--text-secondary);
  user-select: none;
`

const added = css`
  background: var(--diff-add-bg);
  color: var(--diff-add-text);
`

const removed = css`
  background: var(--diff-del-bg);
  color: var(--diff-del-text);
`

type RowKind = 'added' | 'removed' | 'unchanged'

export function ContentDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const parts = diffLines(oldText, newText)
  const rows: { kind: RowKind; text: string }[] = []
  for (const part of parts) {
    const lines = part.value.split('\n')
    // diffLines 的 value 末尾常带换行，会多一个空行，去掉
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const kind: RowKind = part.added ? 'added' : part.removed ? 'removed' : 'unchanged'
    for (const line of lines) rows.push({ kind, text: line })
  }
  return (
    <div className={wrap} data-testid="diff">
      {rows.map((r, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: diff 行无稳定 id
          key={i}
          className={`${row} ${r.kind === 'added' ? added : r.kind === 'removed' ? removed : ''}`}
          data-diff={r.kind}
        >
          <span className={marker}>{r.kind === 'added' ? '+' : r.kind === 'removed' ? '-' : ' '}</span>
          <span>{r.text}</span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/web/components/session/ContentDiff.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/components/session/ContentDiff.tsx src/web/components/session/ContentDiff.test.tsx
git commit -m "feat(web): add ContentDiff for line-level old/new text comparison"
```

---

## Task 8: ReadToolView、WriteToolView（TDD）

read：文件名 + 内容高亮；write：文件名 + 新增内容高亮。共享「文件代码块」模式。

**Files:**
- Create: `src/web/components/session/tools/ReadToolView.tsx`
- Create: `src/web/components/session/tools/WriteToolView.tsx`
- Create: `src/web/components/session/tools/FileCodeBlock.tsx`（共享：文件名 + CodeBlock/纯 pre + 溢出折叠）
- Test: `src/web/components/session/tools/read-write.test.tsx`

- [ ] **Step 1: 写失败测试**

`src/web/components/session/tools/read-write.test.tsx`：
```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReadToolView } from './ReadToolView.js'
import { WriteToolView } from './WriteToolView.js'

describe('ReadToolView', () => {
  it('渲染文件名', () => {
    render(<ReadToolView input={{ path: 'src/a.ts' }} output="const x = 1" />)
    expect(screen.getByTestId('tool-title')).toHaveTextContent('read')
    expect(screen.getByTestId('file-name')).toHaveTextContent('src/a.ts')
  })

  it('error 状态显示错误信息', () => {
    render(<ReadToolView input={{ path: 'a.ts' }} status="error" output={{ _tag: 'error', error: 'no file' } as any} />)
    expect(screen.getByTestId('tool-error')).toHaveTextContent('no file')
  })
})

describe('WriteToolView', () => {
  it('渲染文件名与写入提示', () => {
    render(<WriteToolView input={{ path: 'b.ts', content: 'x' }} />)
    expect(screen.getByTestId('file-name')).toHaveTextContent('b.ts')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/web/components/session/tools/read-write.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 FileCodeBlock（共享）**

`src/web/components/session/tools/FileCodeBlock.tsx`：
```tsx
import { css } from '@linaria/core'
import { CodeBlock } from '../../CodeBlock.js'
import { useOverflow } from '../hooks/useOverflow.js'
import { extToLang } from '../utils/lang.js'

const wrap = css`
  display: flex;
  flex-direction: column;
  margin: 4px 0;
`

const pre = css`
  margin: 0;
  padding: 8px;
  background: var(--code-bg);
  border-radius: 6px;
  overflow: auto;
  font-size: 13px;
  max-height: 400px;
`

const collapsed = css`
  max-height: 300px;
`

const btn = css`
  align-self: flex-start;
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

/** 文件代码块：已知扩展名用 shiki 高亮，否则纯 pre。 */
export function FileCodeBlock({ path, content }: { path: string; content: string }) {
  const lang = extToLang(path)
  const { ref, overflowing, expanded, toggle } = useOverflow(300)
  const showToggle = overflowing && !expanded
  return (
    <div className={wrap}>
      {lang === 'text' ? (
        <pre ref={ref} className={`${pre} ${showToggle ? collapsed : ''}`}>
          {content}
        </pre>
      ) : (
        <div ref={ref} className={showToggle ? collapsed : ''}>
          <CodeBlock code={content} lang={lang} />
        </div>
      )}
      {overflowing && (
        <button type="button" className={btn} onClick={toggle}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 实现 ReadToolView**

`src/web/components/session/tools/ReadToolView.tsx`：
```tsx
import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { FileCodeBlock } from './FileCodeBlock.js'

const title = css`
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 2px;
`

const name = css`
  color: var(--text);
  font-weight: 500;
`

const err = css`
  font-size: 13px;
  color: var(--diff-del-text);
  background: var(--diff-del-bg);
  padding: 6px 8px;
  border-radius: 4px;
`

type ReadInput = { path: string; offset?: number; limit?: number }

export function ReadToolView({
  input,
  output,
  status,
}: {
  input: ReadInput
  output?: ToolResult
  status: string
}) {
  const path = input?.path ?? ''
  if (status === 'error' && output?._tag === 'error') {
    return (
      <div>
        <div className={title} data-testid="tool-title">
          <span className={name}>read</span> · {path}
        </div>
        <div className={err} data-testid="tool-error">
          {output.error}
        </div>
      </div>
    )
  }
  const content = output?._tag === 'success' || output?._tag === 'truncated' ? output.output : ''
  return (
    <div>
      <div className={title} data-testid="tool-title">
        <span className={name}>read</span>
      </div>
      <div className={title} data-testid="file-name">
        {path}
      </div>
      {content && <FileCodeBlock path={path} content={content} />}
    </div>
  )
}
```

- [ ] **Step 5: 实现 WriteToolView**

`src/web/components/session/tools/WriteToolView.tsx`：
```tsx
import { css } from '@linaria/core'
import { FileCodeBlock } from './FileCodeBlock.js'

const title = css`
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 2px;
`

const name = css`
  color: var(--text);
  font-weight: 500;
`

type WriteInput = { path: string; content: string }

export function WriteToolView({ input }: { input: WriteInput }) {
  const path = input?.path ?? ''
  const content = input?.content ?? ''
  return (
    <div>
      <div className={title} data-testid="tool-title">
        <span className={name}>write</span>
      </div>
      <div className={title} data-testid="file-name">
        {path}
      </div>
      <FileCodeBlock path={path} content={content} />
    </div>
  )
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test src/web/components/session/tools/read-write.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/web/components/session/tools/FileCodeBlock.tsx src/web/components/session/tools/ReadToolView.tsx src/web/components/session/tools/WriteToolView.tsx src/web/components/session/tools/read-write.test.tsx
git commit -m "feat(web): add ReadToolView, WriteToolView with FileCodeBlock"
```

---

## Task 9: EditToolView（TDD）

edit：文件名 + ContentDiff(oldText, newText)。

**Files:**
- Create: `src/web/components/session/tools/EditToolView.tsx`
- Test: `src/web/components/session/tools/EditToolView.test.tsx`

- [ ] **Step 1: 写失败测试**

`src/web/components/session/tools/EditToolView.test.tsx`：
```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EditToolView } from './EditToolView.js'

describe('EditToolView', () => {
  it('渲染文件名与 diff', () => {
    render(<EditToolView input={{ path: 'a.ts', oldText: 'old', newText: 'new' }} />)
    expect(screen.getByTestId('file-name')).toHaveTextContent('a.ts')
    expect(screen.getByTestId('diff')).toBeInTheDocument()
    const removed = screen.getByTestId('diff').querySelectorAll('[data-diff="removed"]')
    const added = screen.getByTestId('diff').querySelectorAll('[data-diff="added"]')
    expect(removed.length).toBe(1)
    expect(added.length).toBe(1)
  })

  it('error 状态显示错误', () => {
    render(
      <EditToolView
        input={{ path: 'a.ts', oldText: 'o', newText: 'n' }}
        status="error"
        output={{ _tag: 'error', error: 'not found' } as any}
      />,
    )
    expect(screen.getByTestId('tool-error')).toHaveTextContent('not found')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/web/components/session/tools/EditToolView.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/web/components/session/tools/EditToolView.tsx`：
```tsx
import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { ContentDiff } from '../ContentDiff.js'

const title = css`
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 2px;
`

const name = css`
  color: var(--text);
  font-weight: 500;
`

const err = css`
  font-size: 13px;
  color: var(--diff-del-text);
  background: var(--diff-del-bg);
  padding: 6px 8px;
  border-radius: 4px;
`

type EditInput = { path: string; oldText: string; newText: string }

export function EditToolView({
  input,
  output,
  status,
}: {
  input: EditInput
  output?: ToolResult
  status: string
}) {
  const path = input?.path ?? ''
  const oldText = input?.oldText ?? ''
  const newText = input?.newText ?? ''
  if (status === 'error' && output?._tag === 'error') {
    return (
      <div>
        <div className={title} data-testid="tool-title">
          <span className={name}>edit</span> · {path}
        </div>
        <div className={err} data-testid="tool-error">
          {output.error}
        </div>
      </div>
    )
  }
  return (
    <div>
      <div className={title} data-testid="tool-title">
        <span className={name}>edit</span>
      </div>
      <div className={title} data-testid="file-name">
        {path}
      </div>
      <ContentDiff oldText={oldText} newText={newText} />
    </div>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/web/components/session/tools/EditToolView.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/components/session/tools/EditToolView.tsx src/web/components/session/tools/EditToolView.test.tsx
git commit -m "feat(web): add EditToolView with ContentDiff"
```

---

## Task 10: BashToolView（TDD）

bash：命令（高亮）+ 输出（纯 pre 溢出折叠）+ exit code。

**Files:**
- Create: `src/web/components/session/tools/BashToolView.tsx`
- Test: `src/web/components/session/tools/BashToolView.test.tsx`

- [ ] **Step 1: 写失败测试**

`src/web/components/session/tools/BashToolView.test.tsx`：
```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BashToolView } from './BashToolView.js'

describe('BashToolView', () => {
  it('渲染命令', () => {
    render(<BashToolView input={{ command: 'ls -la' }} />)
    expect(screen.getByTestId('bash-command')).toHaveTextContent('ls -la')
  })

  it('成功时渲染输出与 exit code', () => {
    render(
      <BashToolView
        input={{ command: 'echo hi' }}
        status="completed"
        output={{ _tag: 'success', output: 'hi', metadata: { exitCode: 0 } } as any}
      />,
    )
    expect(screen.getByTestId('bash-output')).toHaveTextContent('hi')
    expect(screen.getByTestId('bash-exit')).toHaveTextContent('0')
  })

  it('失败时渲染错误信息', () => {
    render(
      <BashToolView
        input={{ command: 'bad' }}
        status="error"
        output={{ _tag: 'error', error: 'Command failed with exit code: 127\nx' } as any}
      />,
    )
    expect(screen.getByTestId('bash-output')).toHaveTextContent('exit code: 127')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/web/components/session/tools/BashToolView.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/web/components/session/tools/BashToolView.tsx`：
```tsx
import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { CodeBlock } from '../../CodeBlock.js'
import { useOverflow } from '../hooks/useOverflow.js'

const title = css`
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 4px;
`

const name = css`
  color: var(--text);
  font-weight: 500;
`

const out = css`
  margin: 4px 0 0;
  padding: 8px;
  background: var(--code-bg);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 400px;
`

const collapsed = css`
  max-height: 200px;
`

const btn = css`
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

const exitOk = css`
  font-size: 12px;
  color: var(--success);
`
const exitErr = css`
  font-size: 12px;
  color: var(--error);
`

type BashInput = { command: string; cwd?: string; timeout?: number }

export function BashToolView({
  input,
  output,
  status,
}: {
  input: BashInput
  output?: ToolResult
  status: string
}) {
  const command = input?.command ?? ''
  const { ref, overflowing, expanded, toggle } = useOverflow(200)
  const showToggle = overflowing && !expanded

  // 成功：output.output + metadata.exitCode
  let outText = ''
  let exitCode: number | null = null
  if (output?._tag === 'success') {
    outText = output.output
    exitCode = typeof output.metadata?.exitCode === 'number' ? output.metadata.exitCode : null
  } else if (output?._tag === 'truncated') {
    outText = output.output
  } else if (output?._tag === 'error') {
    outText = output.error
    // 失败时无 metadata，从 error 文本提取 exit code
    const m = output.error.match(/exit code:?\s*(\d+)/i)
    exitCode = m ? Number(m[1]) : null
  }

  return (
    <div>
      <div className={title}>
        <span className={name}>bash</span>
      </div>
      <div data-testid="bash-command">
        <CodeBlock code={command} lang="bash" />
      </div>
      {outText && (
        <div>
          <pre ref={ref} data-testid="bash-output" className={`${out} ${showToggle ? collapsed : ''}`}>
            {outText}
          </pre>
          {overflowing && (
            <button type="button" className={btn} onClick={toggle}>
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
      {exitCode !== null && status !== 'running' && (
        <span
          className={exitCode === 0 ? exitOk : exitErr}
          data-testid="bash-exit"
          style={{ marginLeft: 4 }}
        >
          exit {exitCode}
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/web/components/session/tools/BashToolView.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/components/session/tools/BashToolView.tsx src/web/components/session/tools/BashToolView.test.tsx
git commit -m "feat(web): add BashToolView with command, output, exit code"
```

---

## Task 11: GrepToolView、GlobToolView、FallbackToolView（TDD）

grep/glob：pattern 标题 + 结果折叠；fallback：参数拍平展示。

**Files:**
- Create: `src/web/components/session/tools/GrepToolView.tsx`
- Create: `src/web/components/session/tools/GlobToolView.tsx`
- Create: `src/web/components/session/tools/FallbackToolView.tsx`
- Test: `src/web/components/session/tools/grep-glob-fallback.test.tsx`

- [ ] **Step 1: 写失败测试**

`src/web/components/session/tools/grep-glob-fallback.test.tsx`：
```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FallbackToolView } from './FallbackToolView.js'
import { GlobToolView } from './GlobToolView.js'
import { GrepToolView } from './GrepToolView.js'

describe('GrepToolView', () => {
  it('渲染 pattern', () => {
    render(<GrepToolView input={{ pattern: 'foo' }} output={{ _tag: 'success', output: 'a.ts:1:foo' } as any} status="completed" />)
    expect(screen.getByTestId('tool-title')).toHaveTextContent('foo')
  })
  it('渲染输出', () => {
    render(<GrepToolView input={{ pattern: 'foo' }} output={{ _tag: 'success', output: 'a.ts:1:foo' } as any} status="completed" />)
    expect(screen.getByTestId('tool-output')).toHaveTextContent('a.ts:1:foo')
  })
})

describe('GlobToolView', () => {
  it('渲染 pattern 与文件列表', () => {
    render(<GlobToolView input={{ pattern: '*.ts' }} output={{ _tag: 'success', output: 'a.ts\nb.ts' } as any} status="completed" />)
    expect(screen.getByTestId('tool-title')).toHaveTextContent('*.ts')
    expect(screen.getByTestId('tool-output')).toHaveTextContent('a.ts')
  })
})

describe('FallbackToolView', () => {
  it('拍平展示参数', () => {
    render(<FallbackToolView input={{ a: { b: { c: 1 } }, d: 2 }} tool="custom" />)
    expect(screen.getByTestId('fallback-args').textContent).toContain('a.b.c')
    expect(screen.getByTestId('fallback-args').textContent).toContain('1')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/web/components/session/tools/grep-glob-fallback.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 GrepToolView**

`src/web/components/session/tools/GrepToolView.tsx`：
```tsx
import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { useOverflow } from '../hooks/useOverflow.js'

const title = css`
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 2px;
`

const pre = css`
  margin: 0;
  padding: 8px;
  background: var(--code-bg);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 400px;
`

const collapsed = css`
  max-height: 200px;
`

const btn = css`
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

type GrepInput = { pattern: string; path?: string }

export function GrepToolView({
  input,
  output,
}: {
  input: GrepInput
  output?: ToolResult
  status: string
}) {
  const pattern = input?.pattern ?? ''
  const text = output?._tag === 'success' || output?._tag === 'truncated' ? output.output : output?._tag === 'error' ? output.error : ''
  const { ref, overflowing, expanded, toggle } = useOverflow(200)
  const showToggle = overflowing && !expanded
  return (
    <div>
      <div className={title} data-testid="tool-title">
        Grep · &ldquo;{pattern}&rdquo;
      </div>
      {text && (
        <div>
          <pre ref={ref} data-testid="tool-output" className={`${pre} ${showToggle ? collapsed : ''}`}>
            {text}
          </pre>
          {overflowing && (
            <button type="button" className={btn} onClick={toggle}>
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 实现 GlobToolView**

`src/web/components/session/tools/GlobToolView.tsx`：
```tsx
import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { useOverflow } from '../hooks/useOverflow.js'

const title = css`
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 2px;
`

const pre = css`
  margin: 0;
  padding: 8px;
  background: var(--code-bg);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 400px;
`

const collapsed = css`
  max-height: 200px;
`

const btn = css`
  font-size: 12px;
  color: var(--primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

type GlobInput = { pattern: string; path?: string }

export function GlobToolView({
  input,
  output,
}: {
  input: GlobInput
  output?: ToolResult
  status: string
}) {
  const pattern = input?.pattern ?? ''
  const text = output?._tag === 'success' || output?._tag === 'truncated' ? output.output : output?._tag === 'error' ? output.error : ''
  const { ref, overflowing, expanded, toggle } = useOverflow(200)
  const showToggle = overflowing && !expanded
  return (
    <div>
      <div className={title} data-testid="tool-title">
        Glob · {pattern}
      </div>
      {text && (
        <div>
          <pre ref={ref} data-testid="tool-output" className={`${pre} ${showToggle ? collapsed : ''}`}>
            {text}
          </pre>
          {overflowing && (
            <button type="button" className={btn} onClick={toggle}>
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: 实现 FallbackToolView**

`src/web/components/session/tools/FallbackToolView.tsx`：
```tsx
import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'

const title = css`
  font-size: 13px;
  color: var(--text);
  font-weight: 500;
  margin-bottom: 2px;
`

const pre = css`
  margin: 0;
  padding: 8px;
  background: var(--code-bg);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  overflow: auto;
  max-height: 400px;
`

/** 把嵌套对象拍平成 [path, value] 对，如 {a:{b:1}} => [["a.b",1]]。 */
function flatten(obj: unknown, prefix = ''): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = []
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(...flatten(v, key))
      } else {
        out.push([key, v])
      }
    }
  } else {
    out.push([prefix || '(value)', obj])
  }
  return out
}

export function FallbackToolView({
  tool,
  input,
  output,
}: {
  tool: string
  input: unknown
  output?: ToolResult
}) {
  const pairs = flatten(input ?? {})
  const resultText =
    output?._tag === 'success' || output?._tag === 'truncated'
      ? output.output
      : output?._tag === 'error'
        ? output.error
        : ''
  return (
    <div>
      <div className={title} data-testid="tool-title">
        {tool}
      </div>
      <pre className={pre} data-testid="fallback-args">
        {pairs.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}
      </pre>
      {resultText && (
        <pre className={pre} data-testid="fallback-output">
          {resultText}
        </pre>
      )}
    </div>
  )
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test src/web/components/session/tools/grep-glob-fallback.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/web/components/session/tools/GrepToolView.tsx src/web/components/session/tools/GlobToolView.tsx src/web/components/session/tools/FallbackToolView.tsx src/web/components/session/tools/grep-glob-fallback.test.tsx
git commit -m "feat(web): add GrepToolView, GlobToolView, FallbackToolView"
```

---

## Task 12: ToolBlock 分发组件（TDD）

按 tool 名分发到专用渲染器；渲染工具标题栏（状态 icon）、错误态。

**Files:**
- Create: `src/web/components/session/ToolBlock.tsx`
- Test: `src/web/components/session/ToolBlock.test.tsx`

- [ ] **Step 1: 写失败测试**

`src/web/components/session/ToolBlock.test.tsx`：
```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ToolBlock } from './ToolBlock.js'
import type { RenderBlock } from './utils/normalizeParts.js'

function toolBlock(over: Partial<Extract<RenderBlock, { type: 'tool' }>> = {}): Extract<RenderBlock, { type: 'tool' }> {
  return { type: 'tool', id: '1', tool: 'read', input: { path: 'a.ts' }, status: 'completed', ...over }
}

describe('ToolBlock', () => {
  it('渲染状态 icon', () => {
    render(<ToolBlock block={toolBlock({ status: 'completed' })} />)
    expect(screen.getByTestId('tool-status').getAttribute('data-status')).toBe('completed')
  })

  it('read 工具分发到 ReadToolView', () => {
    render(<ToolBlock block={toolBlock({ tool: 'read', input: { path: 'a.ts' }, output: { _tag: 'success', output: 'x' } })} />)
    expect(screen.getByTestId('file-name')).toHaveTextContent('a.ts')
  })

  it('未知工具用 FallbackToolView', () => {
    render(<ToolBlock block={toolBlock({ tool: 'custom', input: { x: 1 } })} />)
    expect(screen.getByTestId('fallback-args')).toBeInTheDocument()
  })

  it('paused 状态显示权限提示', () => {
    render(<ToolBlock block={toolBlock({ status: 'paused' })} />)
    expect(screen.getByTestId('tool-status').getAttribute('data-status')).toBe('paused')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/web/components/session/ToolBlock.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/web/components/session/ToolBlock.tsx`：
```tsx
import { css } from '@linaria/core'
import type { RenderBlock } from './utils/normalizeParts.js'
import { BashToolView } from './tools/BashToolView.js'
import { EditToolView } from './tools/EditToolView.js'
import { FallbackToolView } from './tools/FallbackToolView.js'
import { GlobToolView } from './tools/GlobToolView.js'
import { GrepToolView } from './tools/GrepToolView.js'
import { ReadToolView } from './tools/ReadToolView.js'
import { WriteToolView } from './tools/WriteToolView.js'

type ToolRenderBlock = Extract<RenderBlock, { type: 'tool' }>

const wrap = css`
  display: flex;
  flex-direction: column;
`

const status = css`
  font-size: 12px;
  margin-bottom: 2px;
`

const STATUS_ICON: Record<ToolRenderBlock['status'], string> = {
  running: '⏳',
  completed: '✓',
  error: '✗',
  paused: '🔒',
}

export function ToolBlock({ block }: { block: ToolRenderBlock }) {
  const { tool, input, output, status: st } = block
  return (
    <div className={wrap}>
      <span className={status} data-testid="tool-status" data-status={st}>
        {STATUS_ICON[st]}
      </span>
      {st === 'paused' ? (
        <div style={{ fontSize: 13, color: 'var(--warning)' }}>等待权限确认</div>
      ) : (
        renderTool(tool, input, output, st)
      )}
    </div>
  )
}

function renderTool(tool: string, input: unknown, output: ToolRenderBlock['output'], status: string) {
  switch (tool) {
    case 'read':
      return <ReadToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'write':
      return <WriteToolView input={(input ?? {}) as never} />
    case 'edit':
      return <EditToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'bash':
      return <BashToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'grep':
      return <GrepToolView input={(input ?? {}) as never} output={output} status={status} />
    case 'glob':
      return <GlobToolView input={(input ?? {}) as never} output={output} status={status} />
    default:
      return <FallbackToolView tool={tool} input={input} output={output} />
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/web/components/session/ToolBlock.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/components/session/ToolBlock.tsx src/web/components/session/ToolBlock.test.tsx
git commit -m "feat(web): add ToolBlock dispatcher with status and per-tool views"
```

---

## Task 13: MessageItem 主组件（TDD，迁移 MessageBubble 断言）

列表式主组件：normalizeParts → 遍历渲染块 → 装饰栏 + 内容。

**Files:**
- Create: `src/web/components/session/MessageItem.tsx`
- Test: `src/web/components/session/MessageItem.test.tsx`

- [ ] **Step 1: 写失败测试（含迁移自 MessageBubble 的断言）**

`src/web/components/session/MessageItem.test.tsx`：
```tsx
import type { Message, MessageContent } from '@shared/types/message.js'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MessageItem } from './MessageItem.js'

function msg(role: 'user' | 'assistant', parts: MessageContent[]): Message {
  return { id: '1', sessionId: 's', role, content: parts, tokenCount: 0, createdAt: 1 }
}

describe('MessageItem', () => {
  it('渲染 user 角色标记', () => {
    render(<MessageItem message={msg('user', [{ _tag: 'text', text: 'hi' }])} />)
    expect(screen.getByTestId('message').getAttribute('data-role')).toBe('user')
  })

  it('渲染 assistant 角色标记', () => {
    render(<MessageItem message={msg('assistant', [{ _tag: 'text', text: 'hello' }])} />)
    expect(screen.getByTestId('message').getAttribute('data-role')).toBe('assistant')
  })

  it('渲染 tool 调用块', () => {
    render(
      <MessageItem
        message={msg('assistant', [
          { _tag: 'tool_call', id: 't1', tool: 'read', input: { path: 'a.ts' } },
        ])}
      />,
    )
    expect(screen.getByTestId('tool-status').getAttribute('data-status')).toBe('running')
  })

  it('渲染 thinking 块（折叠）', () => {
    render(<MessageItem message={msg('assistant', [{ _tag: 'thinking', text: 'hmm' }])} />)
    expect(screen.getByTestId('reasoning').getAttribute('data-expanded')).toBe('false')
  })

  it('多 part 渲染为多个块', () => {
    render(
      <MessageItem
        message={msg('assistant', [
          { _tag: 'text', text: 'a' },
          { _tag: 'tool_call', id: 't', tool: 'read', input: { path: 'x' } },
        ])}
      />,
    )
    expect(screen.getAllByTestId('decoration')).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/web/components/session/MessageItem.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/web/components/session/MessageItem.tsx`：
```tsx
import { css } from '@linaria/core'
import type { Message } from '@shared/types/message.js'
import { AssistantTextBlock } from './AssistantTextBlock.js'
import { PartDecoration } from './PartDecoration.js'
import { ReasoningBlock } from './ReasoningBlock.js'
import { ToolBlock } from './ToolBlock.js'
import { UserTextBlock } from './UserTextBlock.js'
import { normalizeParts } from './utils/normalizeParts.js'

const wrap = css`
  display: flex;
  flex-direction: column;
  padding: 4px 0;
`

const row = css`
  display: flex;
  gap: 8px;
  align-items: flex-start;
`

const content = css`
  flex: 1;
  min-width: 0;
  padding-top: 2px;
`

export function MessageItem({ message }: { message: Message }) {
  const blocks = normalizeParts(message)
  return (
    <div className={wrap} data-testid="message" data-role={message.role}>
      {blocks.map((block, i) => {
        let body: React.ReactNode = null
        switch (block.type) {
          case 'text':
            body =
              block.role === 'user' ? (
                <UserTextBlock text={block.text} />
              ) : (
                <AssistantTextBlock text={block.text} completedAt={message.createdAt || undefined} />
              )
            break
          case 'thinking':
            body = <ReasoningBlock text={block.text} />
            break
          case 'steering':
            body = <UserTextBlock text={block.text} />
            break
          case 'tool':
            body = <ToolBlock block={block} />
            break
        }
        return (
          <div className={row} key={`${block.type}-${i}`}>
            <PartDecoration block={block} />
            <div className={content}>{body}</div>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/web/components/session/MessageItem.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/components/session/MessageItem.tsx src/web/components/session/MessageItem.test.tsx
git commit -m "feat(web): add MessageItem list-style renderer"
```

---

## Task 14: 接入 Chat.tsx，删除旧组件

切换渲染入口，删除 MessageBubble/ToolCall 及其测试，清理引用。

**Files:**
- Modify: `src/web/views/Chat.tsx`（import 与 JSX 改用 MessageItem）
- Delete: `src/web/components/MessageBubble.tsx`
- Delete: `src/web/components/MessageBubble.test.tsx`
- Delete: `src/web/components/ToolCall.tsx`

- [ ] **Step 1: 修改 Chat.tsx**

把 `src/web/views/Chat.tsx` 中的 import：
```ts
import { MessageBubble } from '../components/MessageBubble.js'
```
改为：
```ts
import { MessageItem } from '../components/session/MessageItem.js'
```

把渲染部分：
```tsx
{messages.map((m) => (
  <MessageBubble key={m.id} message={m} />
))}
```
改为：
```tsx
{messages.map((m) => (
  <MessageItem key={m.id} message={m} />
))}
```

- [ ] **Step 2: 删除旧组件**

```bash
git rm src/web/components/MessageBubble.tsx src/web/components/MessageBubble.test.tsx src/web/components/ToolCall.tsx
```

- [ ] **Step 3: 确认无残留引用**

Run: `pnpm test src/web/hooks/useChat.test.ts`
Expected: PASS（确认 useChat 测试未依赖旧组件；如有 import 需一并清理）

确认无残留引用：搜索 `src/web` 下不应再出现 `MessageBubble` 与 `ToolCall` 的 import 或使用（仅 git 历史保留）。
Run: `pnpm test src/web/hooks/useChat.test.ts src/web/hooks/useChat.test.ts`
若 useChat 测试或其他文件仍 import 了已删除组件，一并清理（改为不依赖，或迁移断言到 MessageItem.test.tsx）。

- [ ] **Step 4: typecheck 与 lint**

Run: `pnpm run typecheck:web`
Expected: 无错误

Run: `pnpm run lint`
Expected: 无错误（若有，按提示修复）

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(web): switch Chat to list-style MessageItem, remove bubble components"
```

---

## Task 15: 最终验证

全量测试 + typecheck + lint + 开发服务器冒烟。

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全部 PASS（含新增 session 组件测试与原有测试）

- [ ] **Step 2: typecheck + lint**

Run: `pnpm run typecheck:web && pnpm run lint`
Expected: 无错误

- [ ] **Step 3: 开发服务器冒烟（手动）**

Run: `pnpm run dev`，浏览器打开会话页：
- 用户消息显示为列表式文本块（左侧用户 icon + timeline）
- 助手消息显示 markdown（左侧 sparkle icon）
- 工具调用显示专用渲染器（read 文件高亮 / edit diff / bash 命令+输出）
- 思考块可折叠
- 流式输出实时更新
- 中止/权限确认正常

- [ ] **Step 4: Commit（仅当 lint 自动修复产生了改动）**

先查看是否有改动：`git status --short`。若 dev/build 相关文件被 lint 改动，提交：
```bash
git add -A
git commit -m "style: lint fixes for list-style session render"
```
若无改动，跳过此步（不要提交空 commit）。

---

## 自检清单（实现完成后对照）

- [ ] 列表式架构：每个 part 独立成块 + 左侧装饰栏（icon + timeline）✓ Task 5/13
- [ ] markdown + 复制 + 溢出折叠 ✓ Task 6
- [ ] reasoning 折叠 ✓ Task 6
- [ ] read 文件高亮 ✓ Task 8
- [ ] write 内容高亮 ✓ Task 8
- [ ] edit 行级 diff ✓ Task 7/9
- [ ] bash 命令+输出+exit code ✓ Task 10
- [ ] grep/glob 结果折叠 ✓ Task 11
- [ ] fallback 参数拍平 ✓ Task 11
- [ ] 工具状态 icon（running/completed/error/paused）✓ Task 12
- [ ] 流式集成（text_delta/tool_call_start/end）✓ Task 14（复用现有 useChat）
- [ ] 删除旧组件无残留 ✓ Task 14
- [ ] 全量测试通过 ✓ Task 15
