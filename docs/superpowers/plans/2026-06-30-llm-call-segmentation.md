# LLM 调用分段增量存储 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将「每次 LLM 调用存一份完整 messages/systemPrompt/tools 快照」改为「按前缀指纹分段、段内存轻量增量」，消除 O(N²) 冗余，并让分段由用户操作驱动（变更确认 + 可选压缩）。

**Architecture:** 引入 `LLMSegment`（段首存一次 systemPrompt/tools/provider/model/contextWindow + trigger）与 `LLMCall`（段内轻量元数据：usage/latency/cost/thinking/responseText/finishReason）。loop 每轮计算前缀指纹，与活跃段比对决定开新段或追加 call。`messages` 不再持久化到调用记录（它是 `session_entries` 的派生数据）。分段触发在 Phase 1 自动按指纹/模型变化进行；Phase 3 改为前端预检 + 用户确认驱动。旧 `metadata.llmDetails` 一次性迁移为单个 legacy segment。

**Tech Stack:** TypeScript, Drizzle (PGLite/PostgreSQL), Hono, React 19, Biome, Vitest, react-query.

**参考项目证据：**
- opencode（`packages/core/src/session/`）：消息增量存（`SessionMessageTable` 每条一行），token/cost 在 `SessionTable` SQL 增量累加（`projector.ts:100-105`），compaction 是特殊 message type 作分段边界（`history.ts:17,36-49`），`promptCacheKey: sessionID`（`provider/transform.ts:1093`）。**无每调用完整快照。**
- oh-my-pi（`packages/agent/src/append-only-context.ts`）：`StablePrefix` 用 `computeFingerprint` 检测前缀失效；`AppendOnlyContextManager.syncMessages` 三分支（append / compaction-clear / in-place 最长稳定前缀截断）；`invalidateForModelChange()` 处理模型切换。目的：保 KV cache 命中到分歧点。

---

## File Structure

### Phase 1 — 后端数据层 + loop（应用可运行，调用详情面板待 Phase 2）

- **Modify:** `src/shared/types/agent.ts` — `LLMDetail` 拆为 `LLMSegment` + `LLMCall` + `SegmentTrigger`；`AgentState.llmDetails` → `segments`
- **Modify:** `src/core/agent.ts` — `createAgent` state 初始化 `segments: []`
- **Modify:** `src/core/loop.ts` — 段管理（指纹/触发判定/开段）+ call 构造，替换原 detail 构造
- **Modify:** `src/session/session.ts` — `getLLMDetails`/`appendLLMDetail` → `getLLMSegments`/`saveLLMSegments` + 读取时迁移；新增 `segmentFingerprint` / `migrateLegacyDetails`
- **Modify:** `src/session/index.ts` — 导出新函数名
- **Modify:** `src/server/routes/session.ts` — `/:id/llm-details` 返回 `segments`；删除 `/:id/llm-details/:callId`（或改为段内 call 查询）
- **Modify:** `src/web/services/session.ts` — `llmDetails` 返回类型改为 `LLMSegment[]`（Phase 2 前端消费）
- **Test:** `src/core/loop.test.ts` — detail 断言改段断言；新增分段触发用例
- **Test:** `src/core/steering.test.ts` — state 初始化 `segments: []`
- **Test:** `src/core/agent.test.ts` — state 初始化 `segments: []`
- **Create:** `src/session/segments.test.ts` — 迁移 + 指纹纯函数单测（注明：属 session 层段管理逻辑，无更合适的既有文件）

### Phase 2 — 前端展示适配

- **Modify:** `src/web/components/LLMDetailsView.tsx` — 按段折叠渲染
- **Modify:** `src/web/components/LLMDetail.tsx` — 拆为 `SegmentHeader` + `CallRow`
- **Modify:** `src/web/components/SessionSummary.tsx` — `computeStats` 跨段跨 call 累加
- **Test:** `src/web/components/LLMDetail.test.tsx`、`SessionSummary.test.tsx`

### Phase 3 — 分段触发交互（用户操作驱动）

- **Modify:** `src/server/routes/chat.ts` — 检测 model/tools 与活跃段不同且未带 `confirmSegmentBreak` 时返回 409
- **Modify:** `src/web/views/ChatView.tsx` — selection/enabledTools 变更预检 + 确认弹窗 + 可选压缩
- **Modify:** `src/web/components/ModelSelector.tsx`、`ToolToggle.tsx` — 暴露变更回调
- **Modify:** `src/shared/types/agent.ts` — `AgentEvent` 新增 `segment_break_required`

---

## Phase 1 — 后端数据层 + loop

### Task 1: 类型重构（LLMDetail → LLMSegment + LLMCall）

**Files:**
- Modify: `src/shared/types/agent.ts`

- [ ] **Step 1: 替换 LLMDetail 类型定义为 LLMSegment / LLMCall / SegmentTrigger**

把 `agent.ts` 中现有 `type LLMDetail = { ... }` 整块替换为：

```ts
/** 段内单次 LLM 调用的轻量记录（不含 messages/systemPrompt/tools——那些是段级或派生数据）。 */
type LLMCall = {
  id: string
  timestamp: number
  usage: { input: number; output: number; cacheRead?: number }
  latency: { firstToken: number; total: number }
  cost: number
  thinking?: string
  /** 模型回复文本（替代完整 responseChunks；前端只用文本拼接）。 */
  responseText: string
  /** 非正常停止原因（length/content_filter），正常完成为 undefined。 */
  finishReason?: string
}

/** 触发新段的原因。 */
type SegmentTrigger =
  | 'initial'
  | 'model_change'
  | 'tools_change'
  | 'system_prompt_change'
  | 'compaction'
  | 'user_confirmed'

/**
 * 一段共享相同前缀（systemPrompt + tools + provider + model）的连续 LLM 调用。
 * 段首存一次前缀快照，段内 calls 只记轻量增量，消除每轮重复存储完整 messages 的 O(N²) 冗余。
 */
type LLMSegment = {
  id: string
  /** hash(systemPrompt + 规格化 tools)。变化 = 前缀失效 = cache miss。 */
  fingerprint: string
  provider: string
  model: string
  /** 段首快照：本段生命周期内恒定的系统提示词。 */
  systemPrompt: string
  /** 段首快照：本段启用的工具规格。 */
  tools: ChatTool[]
  startedAt: number
  trigger: SegmentTrigger
  /** 模型上下文窗口（来自 registry capabilities），用于总结面板使用率。段内恒定。 */
  contextWindow?: number
  calls: LLMCall[]
}
```

- [ ] **Step 2: AgentState.llmDetails → segments**

把 `AgentState` 类型中：
```ts
  llmDetails: LLMDetail[]
```
改为：
```ts
  segments: LLMSegment[]
```

- [ ] **Step 3: 更新 export 列表**

把文件末尾 `export type { ... LLMDetail ... }` 中的 `LLMDetail` 替换为 `LLMCall, LLMSegment, SegmentTrigger`。删除 `LLMDetail`。

- [ ] **Step 4: 运行 typecheck 确认类型层已破坏（预期失败，定位下游引用）**

Run: `pnpm -w exec tsc --noEmit 2>&1 | grep -E "llmDetails|LLMDetail|segments" | head -30`
Expected: 报错指向 `core/agent.ts`、`core/loop.ts`、`session/session.ts`、`server/routes/session.ts` 等仍引用 `llmDetails`/`LLMDetail` 的位置。记录这些位置用于后续 Task。

---

### Task 2: session 层段读写 + 迁移 + 指纹

**Files:**
- Modify: `src/session/session.ts`
- Modify: `src/session/index.ts`
- Create: `src/session/segments.test.ts`

- [ ] **Step 1: 先写失败测试 — 指纹稳定性与差异**

Create `src/session/segments.test.ts`：

```ts
/**
 * 段指纹与 legacy 迁移单测。归属：session 层段管理逻辑（segmentFingerprint /
 * migrateLegacyDetails）。无更合适的既有测试文件承载，故新建；后续若合并 session
 * 层测试可并入。
 */
import { describe, expect, it } from 'vitest'
import type { ChatTool } from '../shared/types/llm.js'
import type { LLMSegment } from '../shared/types/agent.js'
import { migrateLegacyDetails, segmentFingerprint } from './session.js'

const tools: ChatTool[] = [
  { name: 'read', description: '读文件', parameters: { type: 'object' } },
]

describe('segmentFingerprint', () => {
  it('相同 systemPrompt + tools → 相同指纹', () => {
    expect(segmentFingerprint('sys', tools)).toBe(segmentFingerprint('sys', tools))
  })
  it('systemPrompt 变化 → 指纹变化', () => {
    expect(segmentFingerprint('sys', tools)).not.toBe(segmentFingerprint('sys2', tools))
  })
  it('tools 变化 → 指纹变化', () => {
    expect(segmentFingerprint('sys', tools)).not.toBe(segmentFingerprint('sys', []))
  })
  it('tools 顺序不同但集合相同 → 指纹相同（规格化）', () => {
    const reversed = [...tools].reverse()
    expect(segmentFingerprint('sys', tools)).toBe(segmentFingerprint('sys', reversed))
  })
})

describe('migrateLegacyDetails', () => {
  it('无 llmDetails 且无 segments → 原样返回', () => {
    const meta = { foo: 1 }
    expect(migrateLegacyDetails(meta)).toEqual(meta)
  })
  it('已有 segments → 不重复迁移', () => {
    const seg: LLMSegment = {
      id: 's1', fingerprint: 'x', provider: 'p', model: 'm',
      systemPrompt: 's', tools: [], startedAt: 1, trigger: 'initial', calls: [],
    }
    const out = migrateLegacyDetails({ segments: [seg] })
    expect(out.segments).toEqual([seg])
    expect(out.llmDetails).toBeUndefined()
  })
  it('llmDetails → 单个 legacy segment，calls 提取 responseText', () => {
    const legacy = {
      llmDetails: [
        {
          id: 'd1', timestamp: 10, model: 'm', provider: 'p', role: { _tag: 'default' },
          systemPrompt: 'sys', messages: [], tools,
          responseChunks: [
            { _tag: 'text', text: 'hel' },
            { _tag: 'text', text: 'lo' },
            { _tag: 'done' },
          ],
          thinking: 'hmm', usage: { input: 1, output: 2, cacheRead: 3 },
          latency: { firstToken: 5, total: 10 }, cost: 0.1, contextWindow: 8000,
        },
      ],
    }
    const out = migrateLegacyDetails(legacy)
    expect(out.llmDetails).toBeUndefined()
    expect(out.segments).toHaveLength(1)
    const seg = out.segments![0]!
    expect(seg.trigger).toBe('initial')
    expect(seg.systemPrompt).toBe('sys')
    expect(seg.tools).toEqual(tools)
    expect(seg.contextWindow).toBe(8000)
    expect(seg.calls).toHaveLength(1)
    expect(seg.calls[0]!.responseText).toBe('hello')
    expect(seg.calls[0]!.thinking).toBe('hmm')
    expect(seg.calls[0]!.usage).toEqual({ input: 1, output: 2, cacheRead: 3 })
  })
})
```

- [ ] **Step 2: 运行测试确认失败（函数未导出）**

Run: `pnpm vitest run src/session/segments.test.ts 2>&1 | tail -20`
Expected: FAIL — `segmentFingerprint` / `migrateLegacyDetails` 未从 session.js 导出。

- [ ] **Step 3: 在 session.ts 实现 segmentFingerprint + migrateLegacyDetails + getLLMSegments + saveLLMSegments**

在 `src/session/session.ts` 顶部 import 区追加 `LLMSegment`（从 `../shared/types/agent.js`），`ChatTool`（从 `../shared/types/llm.js`）。把现有 `getLLMDetails` / `appendLLMDetail` 替换为下列实现：

```ts
/** 规格化工具集并计算前缀指纹。tools 顺序不影响指纹（按 name 排序）。 */
export function segmentFingerprint(systemPrompt: string, tools: ChatTool[]): string {
  const norm = JSON.stringify({
    systemPrompt,
    tools: [...tools]
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  })
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

/**
 * 将旧 metadata.llmDetails 迁移为单个 legacy segment。
 * - 无 llmDetails 或已有 segments → 原样返回。
 * - 否则取首条的 systemPrompt/tools 作为段首快照，所有旧 detail 转为 calls，
 *   responseText 从 responseChunks 的 text 块拼接提取。
 * 幂等：迁移后 llmDetails 字段被移除，不会重复迁移。
 */
export function migrateLegacyDetails(meta: Record<string, unknown>): Record<string, unknown> {
  if (meta.segments !== undefined) return meta
  const legacy = meta.llmDetails
  if (!Array.isArray(legacy) || legacy.length === 0) return meta
  const first = legacy[0] as {
    systemPrompt: string; tools: ChatTool[]; provider: string
    model: string; contextWindow?: number; timestamp: number
  }
  const segment: LLMSegment = {
    id: generateId(),
    fingerprint: segmentFingerprint(first.systemPrompt, first.tools ?? []),
    provider: first.provider,
    model: first.model,
    systemPrompt: first.systemPrompt,
    tools: first.tools ?? [],
    startedAt: first.timestamp,
    trigger: 'initial',
    ...(first.contextWindow !== undefined ? { contextWindow: first.contextWindow } : {}),
    calls: legacy.map((d) => {
      const detail = d as {
        id: string; timestamp: number; usage: LLMSegment['calls'][number]['usage']
        latency: LLMSegment['calls'][number]['latency']; cost: number; thinking?: string
        responseChunks: Array<{ _tag: string; text?: string }>
      }
      return {
        id: detail.id,
        timestamp: detail.timestamp,
        usage: detail.usage,
        latency: detail.latency,
        cost: detail.cost,
        ...(detail.thinking ? { thinking: detail.thinking } : {}),
        responseText: (detail.responseChunks ?? [])
          .map((c) => (c._tag === 'text' && typeof c.text === 'string' ? c.text : ''))
          .join(''),
      }
    }),
  }
  const { llmDetails: _omit, ...rest } = meta
  return { ...rest, segments: [segment] }
}

/** 读取会话 metadata.segments（读取时顺带迁移旧 llmDetails）。 */
export async function getLLMSegments(handle: DB, id: string): Promise<LLMSegment[]> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  if (!row) return []
  const meta = migrateLegacyDetails((row.metadata ?? {}) as Record<string, unknown>)
  return (meta.segments as LLMSegment[] | undefined) ?? []
}

/** 全量替换会话 metadata.segments（每轮 loop 结束写入；段数据轻量）。 */
export async function saveLLMSegments(
  handle: DB,
  id: string,
  segments: LLMSegment[],
): Promise<void> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  if (!row) return
  const meta = migrateLegacyDetails((row.metadata ?? {}) as Record<string, unknown>)
  const { segments: _omit, ...rest } = meta
  const next = { ...rest, segments }
  await handle.db
    .update(sessions)
    .set({ metadata: next, updatedAt: new Date() })
    .where(eq(sessions.id, id))
}
```

删除旧的 `getLLMDetails` 与 `appendLLMDetail` 函数。

- [ ] **Step 4: 更新 src/session/index.ts 导出**

把 `index.ts` 中 `appendLLMDetail, getLLMDetails` 的导出替换为 `getLLMSegments, saveLLMSegments, segmentFingerprint, migrateLegacyDetails`。

- [ ] **Step 5: 运行 segments.test 确认通过**

Run: `pnpm vitest run src/session/segments.test.ts`
Expected: PASS（4 + 3 = 7 用例全过）。

- [ ] **Step 6: Commit**

```bash
git add src/session/session.ts src/session/index.ts src/session/segments.test.ts
git commit -m "feat(session): 分段增量存储 — 段读写/指纹/legacy 迁移"
```

---

### Task 3: state 初始化改 segments

**Files:**
- Modify: `src/core/agent.ts`
- Modify: `src/core/loop.test.ts`
- Modify: `src/core/steering.test.ts`
- Modify: `src/core/agent.test.ts`（若有 state 初始化）

- [ ] **Step 1: createAgent state 初始化**

`src/core/agent.ts` 的 `createAgent` 返回对象中，把：
```ts
    llmDetails: [],
```
改为：
```ts
    segments: [],
```

- [ ] **Step 2: 修正 loop.test.ts 的 makeState**

`src/core/loop.test.ts` 中 `makeState`（约第 128 行）把 `llmDetails: []` 改为 `segments: []`。

- [ ] **Step 3: 修正 steering.test.ts 的 state 字面量**

`src/core/steering.test.ts`（约第 26 行）把 `llmDetails: []` 改为 `segments: []`。

- [ ] **Step 4: 修正 agent.test.ts（若有 llmDetails 字面量）**

Run: `grep -rn "llmDetails" src/core/agent.test.ts src/core/types.test.ts 2>/dev/null`
若有命中，把 `llmDetails: []` / `llmDetails:` 改为 `segments: []` / `segments:`。

- [ ] **Step 5: typecheck 确认 state 层一致（loop.ts 仍报错属预期，下个 Task 修）**

Run: `pnpm -w exec tsc --noEmit 2>&1 | grep -c "segments\|llmDetails"`
Expected: 报错集中在 `loop.ts`（detail 构造）与 `session route`（端点），数量较 Task 1 Step 4 减少。

---

### Task 4: loop 段管理 + call 构造（替换原 detail 构造）

**Files:**
- Modify: `src/core/loop.ts`

本 Task 替换 `loop.ts` 中原 LLMDetail 构造与持久化逻辑（约 363-404 行），改为段管理。需要：(a) import `segmentFingerprint`/`saveLLMSegments` 与新类型；(b) compaction 成功后标记下次开段。

- [ ] **Step 1: 更新 import**

`src/core/loop.ts` 顶部 import 区：
- 把从 `../session/index.js` 的 `appendLLMDetail` 替换为 `saveLLMSegments, segmentFingerprint`。
- 把从 `../shared/types/agent.js` 的 `LLMDetail` 替换为 `LLMCall, LLMSegment, SegmentTrigger`。

- [ ] **Step 2: 替换 detail 构造块为段管理 + call 构造**

定位原块（从 `const totalLatency = Date.now() - requestStartTime` 到 `yield { _tag: 'llm_detail' }`）。整块替换为：

```ts
    const totalLatency = Date.now() - requestStartTime
    let contextWindow: number | undefined
    let computedCost = 0
    try {
      const { capabilities } = resolveRoute(
        deps.llmRegistry,
        state.config.provider,
        state.config.model,
      )
      contextWindow = capabilities.contextWindow
      const inputTokens = collectedUsage?.inputTokens ?? 0
      const outputTokens = collectedUsage?.outputTokens ?? 0
      computedCost =
        (inputTokens / 1000) * capabilities.costPer1kInput +
        (outputTokens / 1000) * capabilities.costPer1kOutput
    } catch {
      // provider 未注册或模型未知：保留 contextWindow=undefined、cost=0
    }

    // —— 段管理：判断是否开新段 ——
    const fp = segmentFingerprint(systemPrompt, tools)
    const activeSeg = state.segments[state.segments.length - 1]
    const pendingTrigger = state.pendingSegmentTrigger
    let openedSegment = false
    let trigger: SegmentTrigger
    if (pendingTrigger) {
      trigger = pendingTrigger
      state.pendingSegmentTrigger = undefined
    } else if (!activeSeg) {
      trigger = 'initial'
    } else if (activeSeg.model !== state.config.model) {
      trigger = 'model_change'
    } else if (activeSeg.fingerprint !== fp) {
      trigger =
        activeSeg.systemPrompt !== systemPrompt ? 'system_prompt_change' : 'tools_change'
    } else {
      trigger = 'user_confirmed' // 占位，实际不会开段
    }
    const needSegment = !!pendingTrigger || !activeSeg
      || activeSeg.model !== state.config.model
      || activeSeg.fingerprint !== fp
    if (needSegment) {
      state.segments.push({
        id: generateId(),
        fingerprint: fp,
        provider: state.config.provider,
        model: state.config.model,
        systemPrompt,
        tools,
        startedAt: requestStartTime,
        trigger,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        calls: [],
      })
      openedSegment = true
    }
    const currentSeg = state.segments[state.segments.length - 1]!

    // —— 段内轻量 call ——
    const call: LLMCall = {
      id: generateId(),
      timestamp: requestStartTime,
      usage: {
        input: collectedUsage?.inputTokens ?? 0,
        output: collectedUsage?.outputTokens ?? 0,
        ...(collectedUsage?.cacheRead !== undefined
          ? { cacheRead: collectedUsage.cacheRead }
          : {}),
      },
      latency: {
        firstToken: firstTokenTime ? firstTokenTime - requestStartTime : totalLatency,
        total: totalLatency,
      },
      cost: computedCost,
      ...(collectedThinking.length > 0 ? { thinking: collectedThinking.join('') } : {}),
      responseText: collectedText.join(''),
      ...(truncated ? { finishReason: truncated } : {}),
    }
    currentSeg.calls.push(call)

    await saveLLMSegments(deps.db, state.session.id, state.segments)
    yield { _tag: 'llm_detail' }
```

- [ ] **Step 3: AgentState 增加可选 pendingSegmentTrigger**

`src/shared/types/agent.ts` 的 `AgentState` 增加字段：
```ts
  /** compaction 等事件要求下一轮强制开新段时设置；loop 消费后清除。 */
  pendingSegmentTrigger?: SegmentTrigger
```

- [ ] **Step 4: compaction 成功后标记下次开段**

在 `loop.ts` 的 compaction 成功分支（`compactionResult.compacted === true` 之后、下一次 turn 之前）加入：
```ts
      state.pendingSegmentTrigger = 'compaction'
```
定位：搜索 `compactionResult` 的使用处，在确认 `compacted` 为真的处理中设置。

- [ ] **Step 5: 修正 loop.test.ts 的两处 detail 断言为段断言**

`src/core/loop.test.ts` 的 `'每轮 LLM 调用后记录 LLMDetail 到 state.llmDetails'` 用例（约 305 行）整块替换为：

```ts
  it('同前缀多轮调用归入同一 segment，calls 增量追加', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    const deps = makeMockDeps(db, () => mockToolThenTextStream())
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    // 两轮调用、前缀不变 → 单段两 call
    expect(state.segments).toHaveLength(1)
    const seg = state.segments[0]
    if (!seg) throw new Error('missing segment')
    expect(seg.trigger).toBe('initial')
    expect(seg.calls).toHaveLength(2)
    expect(seg.systemPrompt).toBeTruthy()
    expect(seg.tools).toEqual([])
    // 段内 call 不含 messages/systemPrompt（轻量）
    const c0 = seg.calls[0]!
    expect(c0.responseText.length).toBeGreaterThan(0)
    expect(c0.latency.total).toBeGreaterThanOrEqual(0)
    const c1 = seg.calls[1]!
    expect(c1.responseText.length).toBeGreaterThan(0)
  })
```

`'LLMDetail 记录 usage 与 thinking'` 用例（约 342 行）替换为：

```ts
  it('call 记录 usage 与 thinking（当 stream 提供）', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    async function* streamWithUsage(): AsyncGenerator<StreamChunk> {
      yield { _tag: 'thinking', text: 'let me think' } as const
      yield { _tag: 'text', text: 'answer' } as const
      yield { _tag: 'usage', inputTokens: 10, outputTokens: 5, cacheRead: 2 } as const
      yield { _tag: 'done' } as const
    }
    const deps = makeMockDeps(db, () => streamWithUsage())
    for await (const _ev of agentLoop(state, deps)) {
      // consume
    }
    expect(state.segments).toHaveLength(1)
    const seg = state.segments[0]
    const call = seg?.calls[0]
    if (!call) throw new Error('missing call')
    expect(call.usage).toEqual({ input: 10, output: 5, cacheRead: 2 })
    expect(call.thinking).toBe('let me think')
    expect(call.responseText).toBe('answer')
  })
```

并确认该文件中 `'emits llm_detail event'`（约 170 行）的断言 `events.some((e) => e._tag === 'llm_detail')` 保持不变（事件名未变）。

- [ ] **Step 6: 新增分段触发测试 — 模型变化开新段**

在 `loop.test.ts` 的 `describe('agentLoop')` 内追加：

```ts
  it('中途 model 变化 → 开新段 trigger=model_change', async () => {
    const messages = await getMessages(db, session.id)
    const state = makeState(session, messages)
    // turn0：mock 模型；之后改 state.config.model 模拟切换
    const deps = makeMockDeps(db, () => mockTextStream('hi'))
    // 先跑一轮建立首段
    const gen = agentLoop(state, deps)
    for await (const _ev of gen) {
      // consume 第一轮
    }
    expect(state.segments).toHaveLength(1)
    // 切换模型后再跑一轮
    state.config.model = 'other-model'
    const gen2 = agentLoop(state, deps)
    for await (const _ev of gen2) {
      // consume
    }
    expect(state.segments).toHaveLength(2)
    expect(state.segments[1]!.trigger).toBe('model_change')
    expect(state.segments[1]!.model).toBe('other-model')
  })
```

注意：`mockTextStream` 需已在该文件定义；若未定义则改用已有的文本流 mock 辅助。`agentLoop` 重新进入需确保不重复 appendMessage——若 `runAgent` 包装会 append，直接调底层 `agentLoop` 并预先 append 一条 user message，或参考文件内已有「多轮」用例的写法对齐。

- [ ] **Step 7: 运行 loop.test 确认通过**

Run: `pnpm vitest run src/core/loop.test.ts`
Expected: PASS（含新增段断言与 model_change 用例）。

- [ ] **Step 8: Commit**

```bash
git add src/core/loop.ts src/core/loop.test.ts src/shared/types/agent.ts
git commit -m "feat(core): loop 段管理 — 指纹判定开段 + 轻量 call 构造"
```

---

### Task 5: session route 端点适配

**Files:**
- Modify: `src/server/routes/session.ts`

- [ ] **Step 1: 替换 import 与两个端点**

`src/server/routes/session.ts` 顶部 import：把 `getLLMDetails` 换为 `getLLMSegments`。

把：
```ts
  app.get('/:id/llm-details', async (c) => {
    const run = ctx.agentManager.get(c.req.param('id'))
    if (run) return c.json(run.state.llmDetails)
    const persisted = await getLLMDetails(ctx.db, c.req.param('id'))
    return c.json(persisted)
  })

  app.get('/:id/llm-details/:callId', async (c) => {
    const id = c.req.param('id')
    const callId = c.req.param('callId')
    const run = ctx.agentManager.get(id)
    const details = run ? run.state.llmDetails : await getLLMDetails(ctx.db, id)
    const found = details.find((d) => d.id === callId)
    if (!found) return apiError(c, 404, 'NOT_FOUND', 'LLM detail not found')
    return c.json(found)
  })
```
替换为：
```ts
  app.get('/:id/llm-details', async (c) => {
    const run = ctx.agentManager.get(c.req.param('id'))
    if (run) return c.json(run.state.segments)
    const persisted = await getLLMSegments(ctx.db, c.req.param('id'))
    return c.json(persisted)
  })
```
（删除 `/:callId` 子端点；call 详情由前端从段内 calls 取。）

- [ ] **Step 2: 修正 session route 测试（若有 llm-details 断言）**

Run: `grep -rn "llm-details\|llmDetails\|LLMDetail" src/server/routes/session.test.ts 2>/dev/null`
若有针对响应结构的断言（如 `body[0].messages`），改为断言 `body[0].calls` / `body[0].systemPrompt`。

- [ ] **Step 3: typecheck + 跑 server 测试**

Run: `pnpm -w exec tsc --noEmit && pnpm vitest run src/server/`
Expected: typecheck 通过；server 测试 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/session.ts src/server/routes/session.test.ts
git commit -m "feat(server): llm-details 端点返回 segments"
```

---

### Task 6: 前端 service 类型 + Phase 1 全量验证

**Files:**
- Modify: `src/web/services/session.ts`
- Modify: `src/web/types/index.ts`

- [ ] **Step 1: service 返回类型改 LLMSegment[]**

`src/web/services/session.ts`：
```ts
  llmDetails: (id: string) => apiRequest<LLMDetail[]>(`/api/sessions/${id}/llm-details`),
```
改为：
```ts
  llmDetails: (id: string) => apiRequest<LLMSegment[]>(`/api/sessions/${id}/llm-details`),
```
import 把 `LLMDetail` 换为 `LLMSegment`。

`src/web/types/index.ts` 的 `export type { ... LLMDetail ... }` 改为导出 `LLMSegment, LLMCall, SegmentTrigger`。

- [ ] **Step 2: 全量测试 + typecheck + lint**

Run: `pnpm -w exec tsc --noEmit && pnpm vitest run && pnpm -w exec biome check src`
Expected: typecheck 通过；测试全绿（前端 LLMDetail/SessionSummary 测试此时仍引用旧 LLMDetail 结构会失败 → 进入 Phase 2 修复；若仅有这两处失败，属预期，记录失败用例数）。

> 注：Phase 1 交付后，`LLMDetail.test.tsx` 与 `SessionSummary.test.tsx` 因消费旧 `LLMDetail` 形状会失败，调用详情面板运行时也会渲染异常。Phase 2 修复。其余测试必须全绿。

- [ ] **Step 3: Commit**

```bash
git add src/web/services/session.ts src/web/types/index.ts
git commit -m "feat(web): service 类型适配 segments（Phase 1 收尾）"
```

---

## Phase 2 — 前端展示适配

### Task 7: LLMDetailsView 按段折叠 + LLMDetail 拆分

**Files:**
- Modify: `src/web/components/LLMDetailsView.tsx`
- Modify: `src/web/components/LLMDetail.tsx`
- Modify: `src/web/components/LLMDetail.test.tsx`

- [ ] **Step 1: 重写 LLMDetail.tsx 为 SegmentHeader + CallRow**

把 `LLMDetail.tsx` 导出改为两个组件。`SegmentHeader` 展示段首快照（model/provider/trigger/systemPrompt/tools），`CallRow` 展示单次 call（responseText/usage/latency/cost/thinking）。保留 `Collapsible` 与样式 class 复用。

```tsx
export function SegmentHeader({ segment }: { segment: LLMSegment }) {
  return (
    <div className={card} data-testid="segment-header">
      <div className={header}>
        <span className={modelName}>{segment.model}</span>
        <span className={dim}>{segment.provider}</span>
        <span className={dim}>· {segment.trigger}</span>
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

export function CallRow({ call, index }: { call: LLMCall; index: number }) {
  return (
    <div className={card} data-testid="call-row">
      <div className={header}>
        <span>调用 #{index}</span>
        <span className={dim}>{new Date(call.timestamp).toLocaleString()}</span>
      </div>
      <div data-testid="call-usage">
        {formatTokenCount(call.usage.input)} in · {formatTokenCount(call.usage.output)} out ·{' '}
        {formatLatency(call.latency.total)} · {formatCost(call.cost)}
      </div>
      {call.thinking && (
        <Collapsible title="Thinking">
          <pre className={pre}>{call.thinking}</pre>
        </Collapsible>
      )}
      <Collapsible title="Response">
        <pre className={pre}>{call.responseText}</pre>
      </Collapsible>
    </div>
  )
}
```
import 从 `@shared/types/agent.js` 取 `LLMSegment, LLMCall`，删除 `LLMDetail`。保留 `ToolSchemaView`、`Collapsible`、样式、`format*` 工具的现有 import。

- [ ] **Step 2: 重写 LLMDetailsView 按段渲染**

`LLMDetailsView.tsx` 把 `details`（`LLMDetail[]`）改为 `segments`（`LLMSegment[]`），渲染时每段一个 `SegmentHeader` + 段内 calls 反序映射 `CallRow`：

```tsx
export function LLMDetailsView({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading, error } = useQuery({
    queryKey: ['session', sessionId, 'llm-details'],
    queryFn: () => sessionAPI.llmDetails(sessionId),
    staleTime: 10_000,
  })
  const segments = data ?? []
  const totalCalls = segments.reduce((s, seg) => s + seg.calls.length, 0)
  return (
    <div className={wrap} data-testid="llm-details-view">
      <button className={toggle} onClick={() => setOpen((v) => !v)} type="button"
        data-testid="llm-details-toggle" aria-expanded={open}>
        <span>{open ? '▾' : '▸'}</span>
        <span>调用详情 ({totalCalls})</span>
      </button>
      {open && (
        <div className={list} data-testid="llm-details-list">
          {isLoading && <span className={status}>加载中…</span>}
          {!isLoading && error && <span className={errStatus}>加载失败</span>}
          {!isLoading && !error && segments.length === 0 && (
            <span className={status}>暂无 LLM 调用记录</span>
          )}
          {!isLoading && !error && segments.map((seg) => (
            <div key={seg.id}>
              <SegmentHeader segment={seg} />
              {[...seg.calls].reverse().map((call, i) => (
                <CallRow key={call.id} call={call} index={seg.calls.length - i} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```
import 取 `SegmentHeader, CallRow` 替换 `LLMDetailPanel`。

- [ ] **Step 3: 重写 LLMDetail.test.tsx**

把测试数据与断言改为 `LLMSegment` + `LLMCall` 形状：渲染 `SegmentHeader` 断言 model/provider/systemPrompt/tools；渲染 `CallRow` 断言 responseText/usage/thinking。用例覆盖：段头展示 trigger、tools 计数、call 的 responseText 与 thinking、空段。

- [ ] **Step 4: 运行前端组件测试**

Run: `pnpm vitest run src/web/components/LLMDetail.test.tsx src/web/components/LLMDetailsView.test.tsx 2>/dev/null || pnpm vitest run src/web/components/LLMDetail.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/web/components/LLMDetail.tsx src/web/components/LLMDetailsView.tsx src/web/components/LLMDetail.test.tsx
git commit -m "feat(web): 调用详情按段折叠渲染"
```

---

### Task 8: SessionSummary 跨段跨 call 累加

**Files:**
- Modify: `src/web/components/SessionSummary.tsx`
- Modify: `src/web/components/SessionSummary.test.tsx`

- [ ] **Step 1: computeStats 改为遍历 segments 的 calls**

`SessionSummary.tsx` 的 `computeStats` 把 `details: LLMDetail[]` 参数改为 `segments: LLMSegment[]`，累加逻辑展开段内 calls：

```ts
function computeStats(
  session: Session | undefined,
  messages: Message[] | undefined,
  segments: LLMSegment[],
): Stats {
  const msgs = messages ?? []
  const userMessages = msgs.filter((m) => m.role === 'user').length
  const assistantMessages = msgs.filter((m) => m.role === 'assistant').length
  const calls = segments.flatMap((s) => s.calls)
  const inputTokens = calls.reduce((s, c) => s + c.usage.input, 0)
  const outputTokens = calls.reduce((s, c) => s + c.usage.output, 0)
  const cacheRead = calls.reduce((s, c) => s + (c.usage.cacheRead ?? 0), 0)
  const cost = calls.reduce((s, c) => s + c.cost, 0)
  const totalTokens = inputTokens + outputTokens + cacheRead
  const lastSeg = segments[segments.length - 1]
  const contextWindow = lastSeg?.contextWindow
  const usagePercent = contextWindow
    ? Math.min(100, Math.round((totalTokens / contextWindow) * 100))
    : undefined
  // ...其余字段（latest model/provider、时间）取 lastSeg
```
`latest.model`/`latest.provider` 改取 `lastSeg?.model`/`lastSeg?.provider`。调用处 `details ?? []` 改为 `segments ?? []`。

- [ ] **Step 2: 修正 SessionSummary.test.tsx 测试数据**

把 `llmDetails: LLMDetail[]` 测试数据改为 `segments: LLMSegment[]`（含 calls）。断言 token/cost 累加值按新结构重算。

- [ ] **Step 3: 运行测试 + 全量验证**

Run: `pnpm vitest run src/web/components/SessionSummary.test.tsx`
Expected: PASS。

- [ ] **Step 4: Phase 2 全量验证**

Run: `pnpm -w exec tsc --noEmit && pnpm vitest run && pnpm -w exec biome check src`
Expected: 全绿，typecheck/lint 干净。

- [ ] **Step 5: Commit**

```bash
git add src/web/components/SessionSummary.tsx src/web/components/SessionSummary.test.tsx
git commit -m "feat(web): SessionSummary 跨段跨 call 统计"
```

---

## Phase 3 — 分段触发交互（用户操作驱动）

### Task 9: 后端 chat 路由分段预检（409）

**Files:**
- Modify: `src/server/routes/chat.ts`
- Modify: `src/shared/types/agent.ts`（AgentEvent 新增事件）

- [ ] **Step 1: /api/chat 检测 model/tools 与活跃段不一致且未确认 → 409**

`chat.ts` 在构造 `agentConfig` 后、`createAgent` 前，读取会话活跃段（内存 run.state.segments 末段 或 DB getLLMSegments 末段）。若存在活跃段且（`provider/model` 或 `tools 集合`）不同，且请求体未带 `confirmSegmentBreak: true`，返回 409：

```ts
      const existingRun = ctx.agentManager.get(session.id)
      const segs = existingRun?.state.segments ?? await getLLMSegments(ctx.db, session.id)
      const active = segs[segs.length - 1]
      const reqTools = new Set(tools)
      const segTools = new Set(active?.tools.map((t) => t.name) ?? [])
      const toolsDiffer = active && (
        reqTools.size !== segTools.size ||
        [...reqTools].some((t) => !segTools.has(t))
      )
      const modelDiffer = active && (active.provider !== provider || active.model !== model)
      const confirmed = (body.confirmSegmentBreak as boolean | undefined) === true
      if ((modelDiffer || toolsDiffer) && !confirmed) {
        return apiError(c, 409, 'SEGMENT_BREAK_REQUIRED',
          '切换模型/工具将开始新的上下文段（缓存失效），需用户确认', {
            activeSegment: active
              ? { provider: active.provider, model: active.model, tools: active.tools.map((t) => t.name) }
              : null,
          })
      }
```
import `getLLMSegments` from session index。`apiError` 若不支持第四参数（details），按其现有签名适配（可把 details 并入 message 或扩 apiError）。

- [ ] **Step 2: chat.test.ts 新增 409 用例 + 确认后成功用例**

- 用例 A：先跑一轮建立段 → 再次 POST 带 `model` 不同于段、不带 `confirmSegmentBreak` → 409。
- 用例 B：同上但带 `confirmSegmentBreak: true` → 200 正常开新段。

- [ ] **Step 3: 运行 chat.test**

Run: `pnpm vitest run src/server/routes/chat.test.ts`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/chat.ts src/server/routes/chat.test.ts
git commit -m "feat(server): 模型/工具变更分段预检 409"
```

---

### Task 10: 前端预检确认弹窗 + 可选压缩

**Files:**
- Modify: `src/web/views/ChatView.tsx`
- Modify: `src/web/components/ModelSelector.tsx`
- Modify: `src/web/components/ToolToggle.tsx`
- Create/Modify: `src/web/components/SegmentBreakDialog.tsx`（确认弹窗）

- [ ] **Step 1: SegmentBreakDialog 确认弹窗组件**

新建轻量弹窗：展示「切换将开新段（缓存失效）」，三选项「继续」「取消」「顺便压缩会话」。回调 `onConfirm(withCompaction: boolean)` / `onCancel()`。带 `data-testid`。

- [ ] **Step 2: ChatView 监听 409 并弹窗**

`handleSend` 的 `sendMessage` 若返回 409（`SEGMENT_BREAK_REQUIRED`），存下待发 payload + activeSegment，渲染 `SegmentBreakDialog`。用户「继续」→ 带 `confirmSegmentBreak: true` 重发；「顺便压缩」→ 先调压缩端点再重发；「取消」→ 还原 selection/enabledTools 到 activeSegment 值。

`sendMessage`/api 层需把 409 body（含 activeSegment）透出。在 `services/api.ts` 或 chat hook 里识别 409 状态码并抛结构化错误。

- [ ] **Step 3: ModelSelector/ToolToggle 暴露即时变更预检（可选增强）**

在用户改 selection/enabledTools 时，若与当前活跃段不同，即时显示一行提示「将开新段」（非阻断），引导。这是体验增强，非阻断式。

- [ ] **Step 4: ChatView.test / 对应测试**

新增：发送遇 409 → 弹窗出现 → 点继续 → 重发带 confirmSegmentBreak；点取消 → selection 还原。

- [ ] **Step 5: 全量验证**

Run: `pnpm -w exec tsc --noEmit && pnpm vitest run && pnpm -w exec biome check src`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/web/views/ChatView.tsx src/web/components/SegmentBreakDialog.tsx src/web/components/ModelSelector.tsx src/web/components/ToolToggle.tsx
git commit -m "feat(web): 分段变更确认弹窗 + 可选压缩"
```

---

## Self-Review

**1. Spec coverage:**
- 段增量数据结构（LLMSegment/LLMCall）→ Task 1 ✓
- 消除 messages/systemPrompt/tools 每轮冗余 → Task 1（段首存一次）+ Task 4（call 不含）✓
- fingerprint 前缀检测 → Task 2/4 ✓
- 分段边界（compaction/model/tools/systemPrompt）→ Task 4 trigger 判定 + Task 4 Step 4 compaction ✓
- 用户操作驱动分段 + 确认 + 可选压缩 → Task 9/10 ✓
- legacy 迁移 → Task 2 ✓
- 前端展示 → Task 7/8 ✓

**2. Placeholder scan:** Phase 3 Task 10 Step 2 的「api 层识别 409」与 Step 3「即时预检」标注为增强，给出方向但依赖现有 chat hook 结构——执行时按 `src/web/hooks/useChat.ts` 实际形态落地，非占位。其余步骤均有具体代码。

**3. Type consistency:** `LLMSegment`/`LLMCall`/`SegmentTrigger` 在 Task 1 定义，Task 2-10 全程引用同名；`state.segments`、`pendingSegmentTrigger`、`saveLLMSegments`/`getLLMSegments`/`segmentFingerprint`/`migrateLegacyDetails` 命名一致。

**已知风险：**
- Task 4 Step 6 的多轮测试依赖 `agentLoop` 可重复进入而不重复 appendMessage；执行时核对 `loop.test.ts` 现有多轮用例范式，必要时改用 `runAgent` 或预 append。
- `apiError` 第四参数（details）需核对 `src/server/routes/helpers` 签名，Task 9 Step 1 据实适配。
- Task 9 的 409 改变了 `/api/chat` 行为，现有依赖「直接成功」的前端/集成测试需同步更新。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-llm-call-segmentation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
