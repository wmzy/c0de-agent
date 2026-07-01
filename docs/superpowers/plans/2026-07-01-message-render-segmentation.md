# 会话详情页消息渲染段化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除多轮调用在消息面板中的重复渲染，改为「每条消息渲染一次 + 段末汇总 + 段断裂分隔」，latency 挂到消息 footer。

**Architecture:** 在 derive 层（`buildTimeline`）增加 latency 配对；新增 `groupBySegment` 纯函数把扁平行按段切分供 `TimelineChat` 分组渲染；`TimelineRow` 类型不变（仅 message 行加 `latency?`），`TableView` 零改动。

**Tech Stack:** React 19, TypeScript, Linaria (CSS-in-JS), Vitest, @testing-library/react

**Spec:** `docs/superpowers/specs/2026-07-01-message-render-segmentation-design.md`

---

## File Map

| 文件 | 责任 | 改动类型 |
|------|------|---------|
| `src/web/components/session/utils/timeline.ts` | `TimelineRow` 类型 + `buildTimeline` + 新增 `groupBySegment` | Modify |
| `src/web/components/session/utils/timeline.test.ts` | latency 配对 + groupBySegment 测试 | Modify |
| `src/web/components/session/TimelineChat.tsx` | 分组渲染（替代行级 switch） | Rewrite |
| `src/web/components/session/TimelineChat.test.tsx` | 适配分组渲染 | Rewrite |
| `src/web/components/session/MessageItem.tsx` | 接收 + 透传 latency | Modify |
| `src/web/components/session/AssistantTextBlock.tsx` | footer 显示 latency | Modify |
| `src/web/components/LLMDetail.tsx` | 移除 SegmentHeader/CallRow，新增 SegmentFooter/SegmentBreak | Modify |
| `src/web/components/LLMDetail.test.tsx` | 适配新组件 | Rewrite |

---

## Task 1: buildTimeline latency 配对 + groupBySegment

**Files:**
- Modify: `src/web/components/session/utils/timeline.ts`
- Test: `src/web/components/session/utils/timeline.test.ts`

- [ ] **Step 1: 写 latency 配对失败测试**

在 `timeline.test.ts` 末尾新增 describe block：

```typescript
describe('buildTimeline latency 配对', () => {
  it('assistant 消息配对最近的 call latency', () => {
    const rows = buildTimeline(
      [msg('m', 100, [{ _tag: 'text', text: 'hi' }])],
      [seg({ startedAt: 50, calls: [{ ...baseCall, id: 'c1', timestamp: 50 }] })],
    )
    const msgRow = rows.find((r) => r.kind === 'message')!
    expect(msgRow.kind).toBe('message')
    if (msgRow.kind === 'message') expect(msgRow.latency).toBe(1500)
  })

  it('user 消息不配对 latency', () => {
    const userMsg: Message = {
      id: 'u', sessionId: 's', role: 'user',
      content: [{ _tag: 'text', text: 'hi' }], tokenCount: 0, createdAt: 100,
    }
    const rows = buildTimeline(
      [userMsg],
      [seg({ startedAt: 50, calls: [{ ...baseCall, id: 'c1', timestamp: 50 }] })],
    )
    const msgRow = rows.find((r) => r.kind === 'message')!
    if (msgRow.kind === 'message') expect(msgRow.latency).toBeUndefined()
  })

  it('latency 不跨段配对', () => {
    // seg1 call@50, seg2 msg@200 — msg 属 seg2，不应配对 seg1 的 call
    const rows = buildTimeline(
      [msg('m', 200, [{ _tag: 'text', text: 'hi' }])],
      [
        seg({ id: 'seg1', startedAt: 50, calls: [{ ...baseCall, id: 'c1', timestamp: 50 }] }),
        seg({ id: 'seg2', startedAt: 150, calls: [{ ...baseCall, id: 'c2', timestamp: 150, latency: { firstToken: 10, total: 800 } }] }),
      ],
    )
    const msgRow = rows.find((r) => r.kind === 'message')!
    if (msgRow.kind === 'message') expect(msgRow.latency).toBe(800)
  })

  it('孤儿 call 不影响配对，仍保留为 call 行', () => {
    const rows = buildTimeline(
      [msg('m', 200, [{ _tag: 'text', text: 'hi' }])],
      [seg({
        startedAt: 1,
        calls: [
          { ...baseCall, id: 'fail', timestamp: 50 },  // 孤儿，无 msg
          { ...baseCall, id: 'ok', timestamp: 100 },   // 配对 msg@200
        ],
      })],
    )
    // 两个 call 行都在
    const callIds = rows.filter((r) => r.kind === 'call').map((r) => r.kind === 'call' ? r.call.id : '')
    expect(callIds).toContain('fail')
    expect(callIds).toContain('ok')
    // msg 配对 ok call
    const msgRow = rows.find((r) => r.kind === 'message')!
    if (msgRow.kind === 'message') expect(msgRow.latency).toBe(1500)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/web/components/session/utils/timeline.test.ts`
Expected: FAIL — `msgRow.latency` is `undefined`

- [ ] **Step 3: 修改 TimelineRow 类型 + buildTimeline 实现 latency 配对**

在 `timeline.ts` 中修改 `TimelineRow` 类型（message 行加 latency）：

```typescript
export type TimelineRow =
  | { kind: 'message'; message: Message; ts: number; latency?: number }
  | { kind: 'call'; call: LLMCall; segment: LLMSegment; ts: number }
  | { kind: 'segment'; segment: LLMSegment; ts: number }
```

在 `buildTimeline` 函数体末尾、`return rows` 之前，追加 latency 配对逻辑：

```typescript
  // latency 配对：assistant 消息配对 timestamp ≤ msg.ts 的最近同段 call。
  // agent loop 严格串行（call 结束→持久化 msg→下一 call），故 msg.ts 恒落在
  // [call.ts, next_call.ts) 内。双指针线性扫描。
  const allCalls = segments.flatMap((s) => s.calls.map((c) => ({ call: c, segStartedAt: s.startedAt })))
  let callIdx = 0
  const consumed = new Set<string>()
  for (const row of rows) {
    if (row.kind !== 'message') continue
    if (row.message.role !== 'assistant') continue
    // 推进到不超过 msg.ts 的最后一个 call
    let best: { call: LLMCall; segStartedAt: number } | null = null
    while (callIdx < allCalls.length && allCalls[callIdx]!.call.timestamp <= row.ts) {
      const candidate = allCalls[callIdx]!
      if (!consumed.has(candidate.call.id)) {
        best = candidate
      }
      callIdx++
    }
    if (best && !consumed.has(best.call.id)) {
      consumed.add(best.call.id)
      row.latency = best.call.latency.total
    }
  }
  return rows
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/web/components/session/utils/timeline.test.ts`
Expected: PASS（含新增 latency 配对用例 + 原有 6 个用例）

- [ ] **Step 5: 写 groupBySegment 失败测试**

在 `timeline.test.ts` 追加：

```typescript
import { groupBySegment, type SegmentGroup } from './timeline.js'

describe('groupBySegment', () => {
  it('segments 为空：所有消息归入单个隐式组', () => {
    const rows = buildTimeline([msg('m', 100, [{ _tag: 'text', text: 'x' }])], [])
    const groups = groupBySegment(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.messages).toHaveLength(1)
    expect(groups[0]!.isFirst).toBe(true)
  })

  it('单段：message 行保留，call 行被滤掉', () => {
    const rows = buildTimeline(
      [msg('m', 100, [{ _tag: 'text', text: 'x' }])],
      [seg({ calls: [{ ...baseCall, id: 'c1', timestamp: 50 }] })],
    )
    const groups = groupBySegment(rows)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.messages.map((m) => m.message.id)).toEqual(['m'])
  })

  it('多段：按 segment 行切分', () => {
    const rows = buildTimeline(
      [msg('m1', 100, [{ _tag: 'text', text: 'a' }]), msg('m2', 300, [{ _tag: 'text', text: 'b' }])],
      [
        seg({ id: 'seg1', startedAt: 50, calls: [{ ...baseCall, id: 'c1', timestamp: 50 }] }),
        seg({ id: 'seg2', startedAt: 200, trigger: 'model_change', calls: [{ ...baseCall, id: 'c2', timestamp: 200 }] }),
      ],
    )
    const groups = groupBySegment(rows)
    expect(groups).toHaveLength(2)
    expect(groups[0]!.segment.id).toBe('seg1')
    expect(groups[1]!.segment.id).toBe('seg2')
    expect(groups[1]!.segment.trigger).toBe('model_change')
  })

  it('隐式首段：segment 行之前的消息归入首段', () => {
    const rows = buildTimeline(
      [msg('m0', 10, [{ _tag: 'text', text: 'pre' }])],
      [seg({ startedAt: 50, calls: [] })],
    )
    const groups = groupBySegment(rows)
    expect(groups).toHaveLength(2)
    // 第一组是隐式组（segment 行之前）
    expect(groups[0]!.isFirst).toBe(true)
    expect(groups[0]!.messages.map((m) => m.message.id)).toEqual(['m0'])
  })

  it('latency 透传到 group messages', () => {
    const rows = buildTimeline(
      [msg('m', 100, [{ _tag: 'text', text: 'x' }])],
      [seg({ calls: [{ ...baseCall, id: 'c1', timestamp: 50 }] })],
    )
    const groups = groupBySegment(rows)
    expect(groups[0]!.messages[0]!.latency).toBe(1500)
  })
})
```

- [ ] **Step 6: 运行确认失败**

Run: `pnpm vitest run src/web/components/session/utils/timeline.test.ts`
Expected: FAIL — `groupBySegment` not exported

- [ ] **Step 7: 实现 groupBySegment**

在 `timeline.ts` 追加：

```typescript
export type SegmentGroup = {
  segment: LLMSegment
  messages: { message: Message; latency?: number }[]
  isFirst: boolean
}

/**
 * 把扁平 TimelineRow[] 按 segment 行切分为有序分组，供 TimelineChat 消费。
 * call 行被丢弃（chat 不渲染）；message 行收入对应段。
 * segments 为空时，所有消息归入单个隐式组（isFirst=true，无 segment 数据）。
 */
export function groupBySegment(rows: TimelineRow[]): SegmentGroup[] {
  const groups: SegmentGroup[] = []
  let current: SegmentGroup | null = null

  for (const row of rows) {
    if (row.kind === 'segment') {
      if (current) groups.push(current)
      current = { segment: row.segment, messages: [], isFirst: groups.length === 0 }
    } else if (row.kind === 'message') {
      if (!current) {
        // segment 行之前的消息：创建隐式首段
        current = {
          segment: { id: '__implicit__', fingerprint: '', provider: '', model: '', systemPrompt: '', tools: [], startedAt: row.ts, trigger: 'initial', calls: [] },
          messages: [],
          isFirst: true,
        }
      }
      current.messages.push({ message: row.message, latency: row.latency })
    }
    // call 行：跳过（chat 不渲染）
  }
  if (current) groups.push(current)
  return groups
}
```

- [ ] **Step 8: 运行全部 timeline 测试**

Run: `pnpm vitest run src/web/components/session/utils/timeline.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 9: Commit**

```bash
git add src/web/components/session/utils/timeline.ts src/web/components/session/utils/timeline.test.ts
git commit -m "feat(web): buildTimeline latency 配对 + groupBySegment 分组函数"
```

---

## Task 2: SegmentFooter + SegmentBreak 组件（替换 SegmentHeader + CallRow）

**Files:**
- Modify: `src/web/components/LLMDetail.tsx`
- Rewrite: `src/web/components/LLMDetail.test.tsx`

- [ ] **Step 1: 重写 LLMDetail.test.tsx**

整个文件替换为：

```typescript
import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SegmentBreak, SegmentFooter } from './LLMDetail.js'

const tools: LLMSegment['tools'] = [
  {
    name: 'read',
    description: '读取文件内容',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'edit',
    description: '编辑文件',
    parameters: { type: 'object', properties: {} },
  },
]

const call: LLMCall = {
  id: 'c1',
  timestamp: 1,
  usage: { input: 10, output: 5 },
  latency: { firstToken: 100, total: 1500 },
  cost: 0.001,
  responseText: 'hello',
}

const segment: LLMSegment = {
  id: 's1',
  fingerprint: 'fp',
  provider: 'openai',
  model: 'gpt-4',
  systemPrompt: 'You are helpful',
  tools,
  startedAt: 1,
  trigger: 'initial',
  contextWindow: 8000,
  calls: [call, { ...call, id: 'c2', cost: 0.002, latency: { firstToken: 50, total: 800 } }],
}

const emptySegment: LLMSegment = { ...segment, id: 's2', tools: [], calls: [] }

describe('SegmentFooter', () => {
  afterEach(() => cleanup())

  it('渲染 model / provider', () => {
    render(<SegmentFooter segment={segment} />)
    const el = screen.getByTestId('segment-footer')
    expect(el.textContent).toContain('gpt-4')
    expect(el.textContent).toContain('openai')
  })

  it('渲染 Σ token 汇总', () => {
    render(<SegmentFooter segment={segment} />)
    const el = screen.getByTestId('segment-footer')
    // (10+5) + (10+5) = 30
    expect(el.textContent).toContain('30')
  })

  it('渲染 Σ cost 汇总', () => {
    render(<SegmentFooter segment={segment} />)
    const el = screen.getByTestId('segment-footer')
    expect(el.textContent).toContain('$0.003')
  })

  it('渲染 Σ latency 汇总', () => {
    render(<SegmentFooter segment={segment} />)
    const el = screen.getByTestId('segment-footer')
    // 1500 + 800 = 2300ms = 2.30s
    expect(el.textContent).toContain('2.30s')
  })

  it('渲染调用次数', () => {
    render(<SegmentFooter segment={segment} />)
    const el = screen.getByTestId('segment-footer')
    expect(el.textContent).toContain('2 次调用')
  })

  it('Tools 面板标题显示工具条数', () => {
    render(<SegmentFooter segment={segment} />)
    expect(screen.getByTestId('tools-summary').textContent).toContain('Tools (2)')
  })

  it('渲染每个工具的名称、描述和 parameters', () => {
    const { container } = render(<SegmentFooter segment={segment} />)
    const text = container.textContent ?? ''
    expect(text).toContain('读取文件内容')
    expect(text).toContain('编辑文件')
    expect(text).toContain('"properties"')
  })

  it('工具为空时显示空态', () => {
    render(<SegmentFooter segment={emptySegment} />)
    expect(screen.getByTestId('tools-summary').textContent).toContain('Tools (0)')
  })

  it('System Prompt 默认折叠但内容在 DOM', () => {
    const { container } = render(<SegmentFooter segment={segment} />)
    expect(container.textContent).toContain('You are helpful')
  })
})

describe('SegmentBreak', () => {
  afterEach(() => cleanup())

  it('trigger=initial 不渲染（返回 null）', () => {
    const { container } = render(<SegmentBreak segment={{ ...segment, trigger: 'initial' }} />)
    expect(container.querySelector('[data-testid="segment-break"]')).toBeNull()
  })

  it('trigger=model_change 渲染分隔线 + 标签', () => {
    const { container } = render(<SegmentBreak segment={{ ...segment, trigger: 'model_change' }} />)
    const el = container.querySelector('[data-testid="segment-break"]')
    expect(el).toBeTruthy()
    expect(el!.textContent).toContain('模型切换')
  })

  it('trigger=compaction 渲染会话压缩标签', () => {
    const { container } = render(<SegmentBreak segment={{ ...segment, trigger: 'compaction' }} />)
    const el = container.querySelector('[data-testid="segment-break"]')
    expect(el!.textContent).toContain('会话压缩')
  })

  it('trigger=system_prompt_change 渲染系统提示词变更标签', () => {
    const { container } = render(<SegmentBreak segment={{ ...segment, trigger: 'system_prompt_change' }} />)
    expect(container.querySelector('[data-testid="segment-break"]')!.textContent).toContain('系统提示词变更')
  })

  it('trigger=tools_change 渲染工具集变更标签', () => {
    const { container } = render(<SegmentBreak segment={{ ...segment, trigger: 'tools_change' }} />)
    expect(container.querySelector('[data-testid="segment-break"]')!.textContent).toContain('工具集变更')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/web/components/LLMDetail.test.tsx`
Expected: FAIL — `SegmentFooter` / `SegmentBreak` not exported

- [ ] **Step 3: 修改 LLMDetail.tsx — 移除旧组件，新增 SegmentFooter + SegmentBreak**

在 `LLMDetail.tsx` 中：

**删除** `SegmentHeader` 函数（约第 149-166 行）和 `CallRow` 函数（约第 171-189 行）。

**替换为** 以下两个新组件（放在 `Collapsible` 和 `ToolSchemaView` 之后）：

```tsx
const breakStyle = css`
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 0;
  padding: 4px 0;
`

const breakLine = css`
  flex: 1;
  height: 1px;
  background: var(--border);
`

const breakLabel = css`
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
`

const BREAK_LABEL: Record<string, string> = {
  model_change: '模型切换',
  system_prompt_change: '系统提示词变更',
  tools_change: '工具集变更',
  compaction: '会话压缩',
  user_confirmed: '用户确认',
}

/** 段末汇总：model + Σtoken + Σcost + Σlatency + 折叠 systemPrompt/tools。每段一次。 */
export function SegmentFooter({ segment }: { segment: LLMSegment }) {
  const totalTokens = segment.calls.reduce(
    (s, c) => s + c.usage.input + c.usage.output, 0,
  )
  const totalCost = segment.calls.reduce((s, c) => s + c.cost, 0)
  const totalLatency = segment.calls.reduce((s, c) => s + c.latency.total, 0)
  return (
    <div className={card} data-testid="segment-footer">
      <div className={header}>
        <span className={modelName}>{segment.model}</span>
        <span className={dim}>{segment.provider}</span>
        <span className={dim}>· {formatTokenCount(totalTokens)} tok</span>
        <span className={dim}>· {formatLatency(totalLatency)}</span>
        <span className={dim}>· {formatCost(totalCost)}</span>
        <span className={dim}>· {segment.calls.length} 次调用</span>
      </div>
      <Collapsible title="System Prompt">
        <pre className={pre}>{segment.systemPrompt}</pre>
      </Collapsible>
      <Collapsible title={`Tools (${segment.tools.length})`} testId="tools-summary">
        {segment.tools.length === 0 ? (
          <span className={dim}>（无工具）</span>
        ) : (
          segment.tools.map((tool) => <ToolSchemaView key={tool.name} tool={tool} />)
        )}
      </Collapsible>
    </div>
  )
}

/** 段断裂分隔线：trigger=initial 或 user_confirmed 时不渲染。 */
export function SegmentBreak({ segment }: { segment: LLMSegment }) {
  const label = BREAK_LABEL[segment.trigger]
  if (!label) return null
  return (
    <div className={breakStyle} data-testid="segment-break">
      <span className={breakLine} />
      <span className={breakLabel}>{label}</span>
      <span className={breakLine} />
    </div>
  )
}
```

**移除文件顶部不再需要的 import**：如果 `LLMCall` 类型只被 `CallRow` 使用，则从 import 中移除 `LLMCall`（`LLMSegment` 仍需）。检查 `SegmentTrigger` 是否需要 import——`BREAK_LABEL` 用 `Record<string, string>` 避免了直接依赖。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/web/components/LLMDetail.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/components/LLMDetail.tsx src/web/components/LLMDetail.test.tsx
git commit -m "feat(web): SegmentFooter + SegmentBreak 替换 SegmentHeader/CallRow"
```

---

## Task 3: MessageItem + AssistantTextBlock 透传 latency

**Files:**
- Modify: `src/web/components/session/MessageItem.tsx`
- Modify: `src/web/components/session/AssistantTextBlock.tsx`

- [ ] **Step 1: 修改 AssistantTextBlock 接收并显示 latency**

在 `AssistantTextBlock.tsx` 中：

修改函数签名（添加 `latency` prop + import `formatLatency`）：

```typescript
import { formatLatency } from '../../utils/format.js'

// ...（其他 import 不变）

export function AssistantTextBlock({
  text,
  completedAt,
  latency,
}: {
  text: string
  completedAt?: number
  latency?: number
}) {
```

修改 footer 区（`assistant-time` span 追加 latency 显示）：

```tsx
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <CopyButton text={text} />
        {(completedAt || latency != null) && (
          <span className={footer} data-testid="assistant-time">
            {completedAt && new Date(completedAt).toLocaleString()}
            {completedAt && latency != null && ' · '}
            {latency != null && formatLatency(latency)}
          </span>
        )}
      </div>
```

- [ ] **Step 2: 修改 MessageItem 接收并透传 latency**

在 `MessageItem.tsx` 中：

修改函数签名：

```typescript
export function MessageItem({
  message,
  latency,
}: {
  message: Message
  latency?: number
}) {
```

在 `switch (block.type)` 的 `'text'` 分支，assistant 路径透传 latency：

```tsx
          case 'text':
            body =
              block.role === 'user' ? (
                <UserTextBlock text={block.text} />
              ) : (
                <AssistantTextBlock
                  text={block.text}
                  completedAt={message.createdAt || undefined}
                  latency={latency}
                />
              )
            break
```

- [ ] **Step 3: Commit**

```bash
git add src/web/components/session/MessageItem.tsx src/web/components/session/AssistantTextBlock.tsx
git commit -m "feat(web): MessageItem + AssistantTextBlock 透传 latency"
```

---

## Task 4: TimelineChat 分组渲染

**Files:**
- Rewrite: `src/web/components/session/TimelineChat.tsx`
- Rewrite: `src/web/components/session/TimelineChat.test.tsx`

- [ ] **Step 1: 重写 TimelineChat.test.tsx**

整个文件替换为：

```typescript
import type { LLMCall, LLMSegment } from '@shared/types/agent.js'
import type { Message } from '@shared/types/message.js'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineRow } from './utils/timeline.js'

// mock MessageItem 为占位（含 latency 透传验证）
vi.mock('./MessageItem.js', () => ({
  MessageItem: ({ message, latency }: { message: Message; latency?: number }) => (
    <div data-testid={`pretty-msg-${message.id}`}>
      msg:{message.id}{latency != null ? `:${latency}ms` : ''}
    </div>
  ),
}))
// mock SegmentFooter / SegmentBreak 为占位
vi.mock('../LLMDetail.js', () => ({
  SegmentFooter: ({ segment }: { segment: { id: string } }) => (
    <div data-testid={`footer-${segment.id}`}>footer:{segment.id}</div>
  ),
  SegmentBreak: ({ segment }: { segment: { id: string; trigger: string } }) =>
    segment.trigger === 'initial' ? null : (
      <div data-testid={`break-${segment.id}`}>break:{segment.id}</div>
    ),
}))

const { TimelineChat } = await import('./TimelineChat.js')

function mkMessage(id: string, text: string | null, createdAt = 1): Message {
  return {
    id,
    sessionId: 's',
    role: 'assistant',
    content: text === null ? [] : [{ _tag: 'text' as const, text }],
    tokenCount: 0,
    createdAt,
  }
}

const seg: LLMSegment = {
  id: 'seg',
  fingerprint: 'fp',
  provider: 'p',
  model: 'm',
  systemPrompt: 'sys',
  tools: [],
  startedAt: 1,
  trigger: 'initial',
  calls: [],
}
const call: LLMCall = {
  id: 'c',
  timestamp: 1,
  usage: { input: 1, output: 1 },
  latency: { firstToken: 1, total: 1 },
  cost: 0,
  responseText: 'r',
}

describe('TimelineChat', () => {
  afterEach(() => cleanup())

  it('segments 为空时退化为纯消息列表（无 footer/break）', () => {
    const rows: TimelineRow[] = [
      { kind: 'message', message: mkMessage('m1', 'hi'), ts: 1 },
    ]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.getByTestId('pretty-msg-m1')).toBeTruthy()
    expect(screen.queryByTestId(/footer-/)).toBeNull()
    expect(screen.queryByTestId(/break-/)).toBeNull()
  })

  it('单段：渲染消息 + footer，无 break', () => {
    const rows: TimelineRow[] = [
      { kind: 'segment', segment: seg, ts: 1 },
      { kind: 'message', message: mkMessage('m1', 'hi'), ts: 100 },
    ]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.getByTestId('pretty-msg-m1')).toBeTruthy()
    expect(screen.getByTestId('footer-seg')).toBeTruthy()
    expect(screen.queryByTestId(/break-/)).toBeNull()
  })

  it('call 行不被渲染', () => {
    const rows: TimelineRow[] = [
      { kind: 'segment', segment: seg, ts: 1 },
      { kind: 'call', call, segment: seg, ts: 50 },
      { kind: 'message', message: mkMessage('m1', 'hi'), ts: 100 },
    ]
    const { container } = render(<TimelineChat rows={rows} showAllJson={false} />)
    // 无 call-row 相关内容
    expect(container.textContent).not.toContain('调用 #')
  })

  it('多段：非首段 trigger≠initial 渲染 break', () => {
    const seg2: LLMSegment = { ...seg, id: 'seg2', trigger: 'model_change', startedAt: 200 }
    const rows: TimelineRow[] = [
      { kind: 'segment', segment: seg, ts: 1 },
      { kind: 'message', message: mkMessage('m1', 'a'), ts: 100 },
      { kind: 'segment', segment: seg2, ts: 200 },
      { kind: 'message', message: mkMessage('m2', 'b'), ts: 300 },
    ]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.getByTestId('break-seg2')).toBeTruthy()
    expect(screen.getByTestId('footer-seg')).toBeTruthy()
    expect(screen.getByTestId('footer-seg2')).toBeTruthy()
  })

  it('latency 透传到 MessageItem', () => {
    const rows: TimelineRow[] = [
      { kind: 'segment', segment: seg, ts: 1 },
      { kind: 'message', message: mkMessage('m1', 'hi'), ts: 100, latency: 1500 },
    ]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.getByTestId('pretty-msg-m1').textContent).toContain('1500ms')
  })

  it('空壳消息默认隐藏', () => {
    const rows: TimelineRow[] = [
      { kind: 'message', message: mkMessage('e', null), ts: 1 },
    ]
    render(<TimelineChat rows={rows} showAllJson={false} />)
    expect(screen.queryByTestId('pretty-msg-e')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/web/components/session/TimelineChat.test.tsx`
Expected: FAIL — 旧 mock（`CallRow`/`SegmentHeader`）不匹配新组件

- [ ] **Step 3: 重写 TimelineChat.tsx**

整个文件替换为：

```typescript
import { css } from '@linaria/core'
import { Fragment, useState } from 'react'
import { SegmentBreak, SegmentFooter } from '../LLMDetail.js'
import { MessageItem } from './MessageItem.js'
import { groupBySegment, isEmptyMessage, type TimelineRow } from './utils/timeline.js'

const groupWrap = css`
  position: relative;
`

const rowWrap = css`
  position: relative;
  padding: 2px 0;
`

const jsonToggle = css`
  position: absolute;
  top: 2px;
  right: 0;
  z-index: 1;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border-radius: 4px;
  padding: 0 6px;
  font-size: 11px;
  cursor: pointer;
  line-height: 18px;

  &:hover {
    color: var(--text);
    border-color: var(--primary);
  }
`

const pre = css`
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  padding: 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 11px;
  max-height: 400px;
  overflow: auto;
`

/**
 * 时间线聊天视图：按段分组渲染。
 * - 每段：非首段 trigger≠initial 时渲染 SegmentBreak → 段内消息 → SegmentFooter。
 * - call 行不渲染（groupBySegment 已滤除）。
 * - 每条消息右上角局部 { } 切换原始 JSON（仅序列化该消息自身）。
 * - showAllJson 全局强制 JSON。
 */
export function TimelineChat({ rows, showAllJson }: { rows: TimelineRow[]; showAllJson: boolean }) {
  const [localJson, setLocalJson] = useState<Set<string>>(new Set())

  const toggle = (key: string) =>
    setLocalJson((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const groups = groupBySegment(rows)

  return (
    <>
      {groups.map((g) => {
        const hasSegmentData = g.segment.id !== '__implicit__'
        return (
          <div className={groupWrap} key={g.segment.id}>
            {hasSegmentData && <SegmentBreak segment={g.segment} />}
            {g.messages.map(({ message, latency }) => {
              const key = `m:${message.id}`
              const isJson = showAllJson || localJson.has(key)
              if (isEmptyMessage(message) && !isJson) return null
              return (
                <div className={rowWrap} key={key}>
                  <button
                    type="button"
                    className={jsonToggle}
                    onClick={() => toggle(key)}
                    data-testid={`row-json-${key}`}
                    aria-label={isJson ? '切换美化' : '切换 JSON'}
                  >
                    {isJson ? '✦' : '{ }'}
                  </button>
                  {isJson ? (
                    <pre className={pre}>{JSON.stringify(message, null, 2)}</pre>
                  ) : (
                    <MessageItem message={message} latency={latency} />
                  )}
                </div>
              )
            })}
            {hasSegmentData && <SegmentFooter segment={g.segment} />}
          </div>
        )
      })}
    </>
  )
}
```

- [ ] **Step 4: 运行 TimelineChat 测试**

Run: `pnpm vitest run src/web/components/session/TimelineChat.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/components/session/TimelineChat.tsx src/web/components/session/TimelineChat.test.tsx
git commit -m "feat(web): TimelineChat 分组渲染（段断裂+消息+段末汇总）"
```

---

## Task 5: 全量验证 + 清理

**Files:**
- Verify only

- [ ] **Step 1: Typecheck**

Run: `pnpm -w exec tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: Biome lint/format**

Run: `pnpm -w exec biome check src --write`
Expected: 无新错误（自动修复格式）

- [ ] **Step 3: 全量 vitest（web 相关）**

Run: `pnpm vitest run src/web/`
Expected: 全部 PASS

- [ ] **Step 4: 检查无残留引用**

搜索 `CallRow`、`SegmentHeader` 是否还有 import 残留：

Run: `pnpm -w exec grep -rn "CallRow\|SegmentHeader" src/`
Expected: 无输出（或仅在 git 历史中）

如果有残留引用，清理后重新运行 Step 1-3。

- [ ] **Step 5: 最终 commit（如有清理改动）**

```bash
git add -A
git commit -m "chore: 清理废弃 CallRow/SegmentHeader 引用"
```
