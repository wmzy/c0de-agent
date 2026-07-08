# 议题驱动压缩（C1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `buildCompactionPrompt` 的摘要骨架从「按工作状态分（Progress/Next Steps）」改成「按议题分（Agenda 状态表）+ 非对称保留（已解决一行、待办完整）」，解决传统压缩把待办蓝图压糊的问题。

**Architecture:** 单纯函数级 prompt 改造。`buildCompactionPrompt(messages, previousSummary?)` 保持签名和序列化逻辑（`serializePart`/`truncateToolOutput`/`history`）不变，只重写 header 指令与章节骨架：新增顶层 `## Agenda` 议题状态表，移除冗余的 `## Progress`（含 Done/InProgress/Blocked 子章节）和 `## Next Steps`。增量模式 header 改为议题状态更新指令。

**Tech Stack:** TypeScript (ESM/NodeNext, strict), Vitest, 纯字符串构造（无 IO）

**Spec:** `docs/superpowers/specs/2026-07-08-agenda-driven-compaction-design.md`

---

## 文件结构

| 文件 | 责任 | 改动 |
|------|------|------|
| `src/session/compaction.ts:92-128` | `buildCompactionPrompt` —— 构造压缩用 prompt | 重写 header 分支 + 章节骨架 |
| `src/session/compaction.test.ts:130-277` | `buildCompactionPrompt` 测试 | 更新 5 个用例断言 + 新增 3 个用例 |

不涉及：DB schema、session entry、archive、前端、API、切点逻辑、触发逻辑、序列化逻辑。

---

## Task 1: 更新测试断言（先让测试失败）

`buildCompactionPrompt` 的 7 个用例中，4 个断言了旧章节/旧 header 文本（用例 1/5/6/7），2 个验证序列化截断（用例 2/3/4，**不改**）。本 Task 改前 4 个用例 + 加 3 个新用例，使其对准新骨架。运行后这些用例会 FAIL（因为 prompt 还是旧模板），驱动 Task 2 的实现。

**Files:**
- Modify: `src/session/compaction.test.ts:130-167`（用例 1）
- Modify: `src/session/compaction.test.ts:241-256`（用例 5）
- Modify: `src/session/compaction.test.ts:260-270`（用例 6）
- Modify: `src/session/compaction.test.ts:273-277`（用例 7）
- Add: 3 个新用例（在 `treats empty-string previousSummary as absent` 之后、`describe('buildCompactionPrompt')` 闭合 `})` 之前）

- [ ] **Step 1: 更新用例 1「includes section headers and entry content」**

把 `src/session/compaction.test.ts:149-166` 的断言块替换为：

```typescript
    const prompt = buildCompactionPrompt(messages)
    // 新增议题骨架
    expect(prompt).toContain('## Agenda')
    // 保留的全局章节
    expect(prompt).toContain('## Goal')
    expect(prompt).toContain('## Constraints & Preferences')
    expect(prompt).toContain('## Relevant Files')
    expect(prompt).toContain('## Key Decisions')
    // 已移除的章节不再出现
    expect(prompt).not.toContain('## Progress')
    expect(prompt).not.toContain('## Next Steps')
    // 对话内容仍被序列化进 prompt
    expect(prompt).toContain('do something')
    expect(prompt).toContain('done')
```

- [ ] **Step 2: 更新用例 5「uses incremental-update header when previousSummary is provided (P0-2)」**

把 `src/session/compaction.test.ts:243-254` 的断言块替换为：

```typescript
    const prompt = buildCompactionPrompt(messages, previous)
    // 增量更新指令（议题状态驱动）
    expect(prompt).toContain('更新以下已有【议题驱动】摘要')
    expect(prompt).toContain('已解决的议题：状态更新为✅')
    // previous-summary 标签包裹已有摘要
    expect(prompt).toContain('<previous-summary>')
    expect(prompt).toContain('</previous-summary>')
    expect(prompt).toContain(previous)
    // 不应再出现从零压缩的头部指令
    expect(prompt).not.toContain('将以下对话历史压缩为一份【议题驱动】的结构化摘要')
    // 议题骨架仍然保留
    expect(prompt).toContain('## Agenda')
    // 新对话历史仍被序列化进 prompt
    expect(prompt).toContain('do more')
    expect(prompt).toContain('done more')
```

- [ ] **Step 3: 更新用例 6「uses from-scratch header when previousSummary is absent (P0-2)」**

把 `src/session/compaction.test.ts:261-269` 的断言块替换为：

```typescript
    const prompt = buildCompactionPrompt(messages)
    // 议题驱动从零压缩头部
    expect(prompt).toContain('将以下对话历史压缩为一份【议题驱动】的结构化摘要')
    // 不应出现增量更新指令
    expect(prompt).not.toContain('更新以下已有')
    expect(prompt).not.toContain('<previous-summary>')
    // 议题骨架
    expect(prompt).toContain('## Agenda')
    // 对话历史仍存在
    expect(prompt).toContain('fresh start')
    expect(prompt).toContain('ok')
```

- [ ] **Step 4: 更新用例 7「treats empty-string previousSummary as absent」**

把 `src/session/compaction.test.ts:274-277` 的断言块替换为：

```typescript
    const prompt = buildCompactionPrompt(messages, '')
    expect(prompt).toContain('将以下对话历史压缩为一份【议题驱动】的结构化摘要')
    expect(prompt).not.toContain('<previous-summary>')
```

- [ ] **Step 5: 新增 3 个用例**

在 `treats empty-string previousSummary as absent` 用例的 `})` 之后、`describe('buildCompactionPrompt')` 的闭合 `})` 之前（即当前文件第 278 行附近）插入：

```typescript

  it('does not include Progress or Next Steps sections', () => {
    const messages: Message[] = [mk('user', 'task'), mk('assistant', 'ok')]
    const prompt = buildCompactionPrompt(messages)
    expect(prompt).not.toContain('## Progress')
    expect(prompt).not.toContain('### Done')
    expect(prompt).not.toContain('### In Progress')
    expect(prompt).not.toContain('### Blocked')
    expect(prompt).not.toContain('## Next Steps')
  })

  it('includes asymmetric retention instruction in from-scratch header', () => {
    const messages: Message[] = [mk('user', 'fix issue 1 then 2')]
    const prompt = buildCompactionPrompt(messages)
    expect(prompt).toContain('已解决的议题只留一行结论')
    expect(prompt).toContain('必须完整保留')
  })

  it('Agenda section documents status markers', () => {
    const messages: Message[] = [mk('user', 'review')]
    const prompt = buildCompactionPrompt(messages)
    expect(prompt).toContain('✅已解决')
    expect(prompt).toContain('⏳进行中')
    expect(prompt).toContain('🔒阻塞')
    expect(prompt).toContain('📋待办')
  })
```

- [ ] **Step 6: 运行测试，确认 7 个用例失败（旧模板不满足新断言）**

Run: `pnpm exec vitest run src/session/compaction.test.ts -t 'buildCompactionPrompt'`
Expected: 7 个用例 FAIL（用例 2/3/4 因断言只涉及序列化截断，可能仍 PASS——这是正常的，它们不受影响）。关键是用例 1/5/6/7 + 3 个新用例全部 FAIL，证明断言已对准新骨架。

- [ ] **Step 7: Commit**

```bash
git add src/session/compaction.test.ts
git commit -m "test(compaction): update buildCompactionPrompt assertions for agenda-driven skeleton"
```

---

## Task 2: 重写 buildCompactionPrompt 实现

把 `buildCompactionPrompt` 的 header 和章节骨架替换为议题驱动版本。序列化逻辑（`history` 构造）**完全不变**。

**Files:**
- Modify: `src/session/compaction.ts:92-128`

- [ ] **Step 1: 定位当前实现**

确认 `src/session/compaction.ts` 第 92 行起的 `buildCompactionPrompt` 函数体。当前实现（关键部分）：

```typescript
function buildCompactionPrompt(messages: Message[], previousSummary?: string): string {
  const history = messages
    .map((m) => `[${m.role}] ${m.content.map((p) => serializePart(p)).join(' ')}`)
    .join('\n')

  const header = previousSummary
    ? `更新以下已有摘要，保留仍成立的细节，移除过时信息，合并新事实。

<previous-summary>
${previousSummary}
</previous-summary>`
    : '将以下对话历史压缩为结构化摘要。保留关键信息，丢弃冗余细节。'

  return `${header}

## Goal
...
## Progress
### Done
...
### Next Steps
...
${history}`
}
```

- [ ] **Step 2: 替换 header 分支**

把 `const header = previousSummary ? ... : ...` 整段替换为：

```typescript
  const sections = `## Agenda
逐条列出对话中出现的议题/任务，按处理顺序排列。每条格式：
- **[议题标题]** — ✅已解决 / ⏳进行中 / 🔒阻塞 / 📋待办
  - ✅/🔒 → 一行：最终结论或卡点
  - ⏳/📋 → 完整保留：目标、约束、已尝试方向、相关文件路径、关键决策、待确认问题

## Goal
用户此次会话的总体目标（若 Agenda 已涵盖，写"见 Agenda"）

## Constraints & Preferences
用户约束、偏好、规范要求（或"(none)"）

## Key Decisions
做出的关键决策及原因

## Critical Context
必须记住的技术事实（文件路径、变量名、命令、错误信息、未解决问题）

## Modified Files
修改过的文件路径及变更摘要

## Relevant Files
对任务重要的文件/目录路径及原因`

  const header = previousSummary
    ? `更新以下已有【议题驱动】摘要。重点：
- 已解决的议题：状态更新为✅并压缩为一行结论；
- 新增议题：补入 Agenda 并完整保留其描述与约束；
- 尚未解决的议题：保持其原有描述与约束不变，只叠加本轮新进展。

<previous-summary>
${previousSummary}
</previous-summary>`
    : `将以下对话历史压缩为一份【议题驱动】的结构化摘要。
核心原则——非对称保留：已解决的议题只留一行结论；尚未解决/待办的议题
必须完整保留其描述、约束、已尝试方向、相关文件与待确认问题，它们是后续
工作的蓝图，绝不可被稀释。`
```

- [ ] **Step 3: 替换 return 模板**

把原来的 `return \`${header}\n\n## Goal\n...## Progress\n...## Next Steps\n...\n---\n对话历史：\n${history}\`` 替换为（`sections` 已含所有章节，header 不含章节）：

```typescript
  return `${header}

${sections}

---
对话历史：
${history}`
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run: `pnpm exec vitest run src/session/compaction.test.ts -t 'buildCompactionPrompt'`
Expected: 全部 PASS（10 个用例：4 个更新 + 3 个新增 + 3 个序列化截断用例不变）。

- [ ] **Step 5: Commit**

```bash
git add src/session/compaction.ts
git commit -m "feat(compaction): 议题驱动摘要骨架——Agenda 状态表 + 非对称保留"
```

---

## Task 3: 全量验证与类型检查

确保改动不破坏 compaction 模块的其他用例和整体类型。

**Files:** 无改动，仅运行验证。

- [ ] **Step 1: 运行 compaction 全部测试**

Run: `pnpm exec vitest run src/session/compaction.test.ts`
Expected: 全部 PASS（包括 `findSafeCutPoint`、`extractHotFiles`、`compactSession` 等 describe 块——它们不受 prompt 改动影响）。

- [ ] **Step 2: 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 0 errors（纯字符串改动，不引入类型变化）。

- [ ] **Step 3: Lint**

Run: `pnpm exec biome check src/session/compaction.ts src/session/compaction.test.ts`
Expected: 无 error（可能因模板字符串格式有 warning，修正格式即可）。

- [ ] **Step 4: 最终 commit（如有 lint 修正）**

```bash
git add src/session/compaction.ts src/session/compaction.test.ts
git diff --cached --quiet || git commit -m "chore: agenda-driven compaction — lint pass"
```
