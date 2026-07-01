# 会话详情页消息渲染优化：段化展示

> 日期：2026-07-01
> 状态：待实现
> 关联：`2026-06-30-llm-call-segmentation`（段数据模型已就绪）、`2026-06-28-session-list-render`（MessageItem 渲染）

## 1. 问题

数据层已用 `LLMSegment` + `LLMCall` 消除了多轮调用的 O(N²) 冗余——段首快照存一次 systemPrompt/tools/model/provider（`agent.ts:88-103`），段内 calls 只存轻量增量。但**渲染层（`buildTimeline` + `TimelineChat`）仍按旧模式**把三者交错成一维流，导致：

1. **每次调用渲染一个独立「调用 #N」卡片**（`LLMDetail.tsx:171` `CallRow`），与 `MessageItem` 中的 assistant 文本**内容重复**。
2. **段级数据（model、systemPrompt、token）挂在段内每个 call 上**，视觉上重复 N 次——而这些在段内是恒定的。
3. **`SegmentHeader` 位于段首**，打断阅读流；且无段断裂的视觉体现。
4. **assistant 消息没有 latency 信息**——删掉 CallRow 后，唯一会丢失的时间维度。

## 2. 目标

| # | 目标 | 验收 |
|---|------|------|
| G1 | 删除 `CallRow` 独立渲染——美化视图不再为每次调用出块 | 美化视图中无 `call-row` 元素 |
| G2 | 每条 message 只渲染一次（文本/thinking/tool 调用已在 MessageItem） | assistant 文本不出现两次 |
| G3 | 段末汇总：model + provider + Σtoken + Σcost + Σlatency + 折叠 systemPrompt/tools，挂在该段最后一条 message 后 | 每段最多一个 `segment-footer` |
| G4 | 段断裂：`trigger ∈ {model_change, system_prompt_change, tools_change, compaction}` 时画分隔线 + 原因标签 | 断裂处有 `segment-break` 元素 |
| G5 | 调用时间（latency）挂到产生它的 assistant 消息 footer | `assistant-time` 旁显示 latency |
| G6 | 表格视图（TableView）和原始 JSON 面板保留全部调用级详情 | 不改动，回归确认 |

## 3. 非目标（YAGNI）

- **不改 message id / 引用机制**：流式期间前端用临时 id（`hooks/id.ts`）是独立问题；刷新后后端 UUID 可用，`@[messageId:n]` 引用刷新后正常。本次不碰。
- **不改后端 / 数据模型**：`LLMSegment`/`LLMCall`/`Message` 类型不变。
- **不改表格视图 / JSON 面板**：它们是「详情面板」，消息面板是「阅读流」，两者职责分离。
- **不展示调用级 finishReason / cacheRead**：这些在 TableView 详查，消息面板只给段级汇总。

## 4. 数据流

```
                         ┌─ history (useMessages) ─┐
useChat + segments query ─┤                         ├─→ messages[] ──┐
                         └─ segments[] ────────────┴────────────────┤
                                                                       ▼
                          buildTimeline(messages, segments)   ← +latency 配对
                                       │
                            TimelineRow[]  (类型不变，仅 message 行 +latency)
                                  │                              │
                     groupBySegment()                           │ （直接消费）
                          │                                      ▼
                   SegmentGroup[]                          TableView (不变)
                          │
                          ▼
                   TimelineChat (分组渲染)
```

- `buildTimeline`：现有逻辑不变 + latency 配对（G5）。
- `groupBySegment`：新纯函数，把行按段切分，供 TimelineChat 消费。
- `TableView`：消费原始 `TimelineRow[]`，不受影响（G6）。

## 5. 详细设计

### 5.1 TimelineRow 类型（`utils/timeline.ts`）——保持兼容

**不新增/移除 kind**。仅在 message 行追加可选 `latency` 字段：

```ts
export type TimelineRow =
  | { kind: 'message'; message: Message; ts: number; latency?: number }   // ← +latency
  | { kind: 'call'; call: LLMCall; segment: LLMSegment; ts: number }       // 不变（TableView 用）
  | { kind: 'segment'; segment: LLMSegment; ts: number }                  // 不变（TableView 用）
```

- `call` / `segment` 行**保留**：TableView 依赖它们展示调用级详情（用户明确要求表格保留详情）。
- TimelineChat 在渲染时**跳过** `call` 行、用 `segment` 行做分组边界。
- 新增独立纯函数 `groupBySegment`（见 §5.2）做分组，TimelineChat 不再做行级映射。

### 5.2 groupBySegment 函数（新，`utils/timeline.ts`）

把扁平 `TimelineRow[]` 按 segment 边界切成有序分组，供 TimelineChat 消费：

```ts
type SegmentGroup = {
  segment: LLMSegment              // 该段的完整信息（model/systemPrompt/tools/Σcalls）
  messages: { message: Message; latency?: number }[]  // 段内消息（已滤掉 call 行）
  isFirst: boolean                  // 是否会话首段（首段不渲染断裂线）
}

function groupBySegment(rows: TimelineRow[]): SegmentGroup[]
```

算法：
1. 以 `segment` 行为分隔符切分。
2. 段内 message 行收入 `messages`（带配对好的 latency）；call 行丢弃（chat 不渲染）。
3. 若某 message 不属于任何 segment（无前置 segment 行），归入一个隐式首段。

**latency 配对逻辑仍在 `buildTimeline` 中完成**（步骤 2），groupBySegment 只是消费它。

这样 TimelineChat 只做 `groups.map(g => <>break + messages + footer</>)`，TableView 消费原始 rows 不受影响。

### 5.3 buildTimeline 增强（`utils/timeline.ts`）

现有逻辑不变（产出 message/call/segment 行，按时间交错排序）。仅增加一步 latency 配对：

```
在现有排序完成后，对每条 assistant message 行：
  - 在全局 calls 列表中找 timestamp ≤ message.ts 的最后一个 call
  - 配对后该 call 标记 consumed（不重复配对）
  - 将 latency.total 写入 message 行

不变量保证：agent loop 严格串行（call 结束 → 持久化 msg → 下一 call），
故 msg.createdAt 恒落在 [call.ts, next_call.ts) 内。

仅 assistant 消息参与配对；user/system 消息 latency = undefined。
孤儿 call（无对应 message）不影响配对，仍作为 call 行保留（TableView 可见），
其 token/cost 计入 SegmentFooter 的 Σ 汇总。
```

**配对算法复杂度**：calls 和 messages 都已按时间排序，线性双指针 O(N+M)。

### 5.4 SegmentFooter 组件（新，拆自 `LLMDetail.tsx` 的 `SegmentHeader`）

```tsx
export function SegmentFooter({ segment }: { segment: LLMSegment }) {
  const totalTokens = segment.calls.reduce((s, c) => s + c.usage.input + c.usage.output, 0)
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
        <pre>{segment.systemPrompt}</pre>
      </Collapsible>
      <Collapsible title={`Tools (${segment.tools.length})`}>
        {segment.tools.map(t => <ToolSchemaView key={t.name} tool={t} />)}
      </Collapsible>
    </div>
  )
}
```

- 复用 `Collapsible`、`ToolSchemaView`（现有 `LLMDetail.tsx` 内部组件）。
- 复用 `formatTokenCount`/`formatLatency`/`formatCost`（`utils/format.ts`）。
- 默认折叠 systemPrompt/tools，点击展开。

### 5.5 SegmentBreak 组件（新）

```tsx
const BREAK_LABEL: Record<SegmentTrigger, string> = {
  initial: '',
  model_change: '模型切换',
  system_prompt_change: '系统提示词变更',
  tools_change: '工具集变更',
  compaction: '会话压缩',
  user_confirmed: '用户确认',
}

export function SegmentBreak({ segment }: { segment: LLMSegment }) {
  return (
    <div className={breakStyle} data-testid="segment-break">
      <span className={breakLine} />
      <span className={breakLabel}>{BREAK_LABEL[segment.trigger]}</span>
      <span className={breakLine} />
    </div>
  )
}
```

视觉：横线 + 标签 + 横线（居中分隔线样式）。仅 `trigger ≠ 'initial'` 时渲染。

### 5.6 TimelineChat 改动（`TimelineChat.tsx`）

从行级映射改为分组渲染：

```tsx
export function TimelineChat({ rows, showAllJson }: { rows: TimelineRow[]; showAllJson: boolean }) {
  const groups = groupBySegment(rows)
  return groups.map((g) => (
    <Fragment key={g.segment.id}>
      {!g.isFirst && g.segment.trigger !== 'initial' && <SegmentBreak segment={g.segment} />}
      {g.messages.map(({ message, latency }) => (
        <MessageRow key={message.id} message={message} latency={latency} showAllJson={showAllJson} />
      ))}
      <SegmentFooter segment={g.segment} />
    </Fragment>
  ))
}
```

- 不再逐行 switch on row.kind；改为 groupBySegment → 段级渲染。
- call 行被 groupBySegment 滤掉，不渲染。
- JSON 按钮逻辑移入 MessageRow（每条消息的 `{ }` 只序列化自身）和 SegmentFooter（序列化 segment）。
- 空壳消息（isEmptyMessage）在 JSON 关闭时仍隐藏。

### 5.7 MessageItem + AssistantTextBlock 改动（latency 透传）

```tsx
// MessageItem.tsx
export function MessageItem({ message, latency }: { message: Message; latency?: number }) {
  // ...
  // assistant text block 透传 latency
  <AssistantTextBlock text={block.text} completedAt={message.createdAt || undefined} latency={latency} />
}

// AssistantTextBlock.tsx
export function AssistantTextBlock({ text, completedAt, latency }: {
  text: string; completedAt?: number; latency?: number
}) {
  // footer 区：时间戳 · latency 并列
  <span data-testid="assistant-time">
    {completedAt && new Date(completedAt).toLocaleString()}
    {latency != null && ` · ${formatLatency(latency)}`}
  </span>
}
```

非 assistant 消息（user/system）不传 latency，footer 不变。

### 5.7 LLMDetail.tsx 清理

- **移除** `SegmentHeader`（被 `SegmentFooter` 替代，迁至新位置或同文件重命名）。
- **移除** `CallRow`（不再渲染）。
- 保留 `Collapsible`、`ToolSchemaView`（被 SegmentFooter 复用）。
- 文件改名为 `SegmentViews.tsx`？——**不改名**，避免大面积 import 变更；导出 `SegmentFooter` + `SegmentBreak` 即可。

## 6. 测试策略

### 6.1 buildTimeline 单测（`timeline.test.ts` 扩充）

现有 6 个用例**不受影响**（行类型不变）。新增 latency 配对用例：

- `latency 配对：assistant msg@100 配对 call@50(ts<100)，latency=1500`
- `latency 不跨段：msg 属 seg2 不配对 seg1 的 call`
- `user/system 消息不配对 latency`
- `孤儿 call 不影响配对，仍保留为 call 行`

### 6.2 groupBySegment 单测（`timeline.test.ts` 新增 describe）

- `单段：返回一个 SegmentGroup，isFirst=true`
- `多段：按 segment 行切分，顺序正确`
- `call 行被滤掉，只留 messages`
- `隐式首段：segment 行之前的 message 归入首段`

### 6.3 组件渲染测

- `SegmentFooter`：渲染 Σtoken/Σcost/Σlatency/调用次数，折叠 systemPrompt/tools 默认隐藏。
- `SegmentBreak`：trigger=initial 不渲染，其余渲染分隔线 + 标签。
- `AssistantTextBlock`：latency 存在时 footer 显示 `· 1.5s`；不存在时不显示。
- `TimelineChat`：无 `call-row` 元素；每段末有一个 `segment-footer`；非首段 trigger≠initial 有 `segment-break`。

### 6.4 回归

- `LLMDetail.test.tsx`：适配（CallRow 测试删除/改名，SegmentHeader → SegmentFooter）。
- `TableView.test.tsx`：不变（TableView 不改）。
- `TimelineChat.test.tsx`：适配分组渲染。

## 7. 风险

| 风险 | 缓解 |
|------|------|
| latency 配对在并发/乱序场景失效 | agent loop 严格串行，不变量可靠；配对失败时 latency=undefined，不渲染，无错误 |
| 流式中 latency 缺失（call 未持久化） | 与 segments query 加载时机一致；`llm_detail` 事件刷新后补上 |
| 孤儿 call 不可见 | Σ 汇总含孤儿 call 的 token/cost；逐条查在 TableView |
| 现有测试大面积失败 | 受影响测试集中在 LLMDetail.tsx + TimelineChat.tsx，已枚举（§6）；timeline.test.ts 现有用例不受影响（行类型不变） |

## 8. 文件清单

| 文件 | 改动 |
|------|------|
| `src/web/components/session/utils/timeline.ts` | message 行 +latency；新增 `groupBySegment` |
| `src/web/components/session/utils/timeline.test.ts` | 新增 latency 配对 + groupBySegment 用例 |
| `src/web/components/session/TimelineChat.tsx` | 改用 groupBySegment 分组渲染 |
| `src/web/components/session/TimelineChat.test.tsx` | 适配分组渲染 |
| `src/web/components/session/MessageItem.tsx` | 接收 + 透传 latency |
| `src/web/components/session/AssistantTextBlock.tsx` | footer 显示 latency |
| `src/web/components/LLMDetail.tsx` | 移除 SegmentHeader/CallRow，新增 SegmentFooter/SegmentBreak |
| `src/web/components/LLMDetail.test.tsx` | 适配 |

## 9. 不涉及的文件

- 后端（`src/core/*`, `src/server/*`, `src/session/*`）：零改动。
- `src/shared/types/*`：零改动。
- `useChat.ts`、`ChatView.tsx`：零改动（数据源不变，timeline 仍由 `buildTimeline` 产出）。
