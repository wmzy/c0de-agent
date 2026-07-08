# 议题驱动压缩（方案 C1）：摘要按议题组织 + 非对称保留

> 日期：2026-07-08
> 状态：待实现
> 关联：`src/session/compaction.ts`（现有 LLM 摘要 compaction）、`docs/superpowers/specs/2026-07-08-shake-compaction-design.md`（shake 互补机制）
> 范围：这是「状态驱动压缩」三阶段路径（C → B → A）的**第一阶段**。本 spec 仅覆盖 C。

## 1. 背景

现有 compaction 是**时序+token 阈值驱动**的：`shouldCompact` 看预算，`findKeepRecentStart` 按预算从最新向前走，`findSafeCutPoint` 对齐到 user 轮次，旧消息整体送 `summarizer`。它隐含假设「信息价值 ∝ 新鲜度」。

但存在一个反例场景：agent 罗列了多个修改建议（议题），用户先与 agent 沟通并修好第一个。此时——

| 内容 | 时间位置 | 实际价值 |
|------|---------|---------|
| 待办议题列表（未处理的问题） | 最老 | **最高**（后续工作的蓝图） |
| 已修好的第一个议题的讨论 | 最新 | 低（已闭环） |

传统压缩正好压反：把价值最高的待办蓝图摘要掉，把已闭环的讨论原样留着。这是**价值维度和时间维度的错配**。

更具体地看现状：`buildCompactionPrompt`（`src/session/compaction.ts:92`）生成的摘要**已经是结构化的**（Goal / Constraints / Progress(Done/InProgress/Blocked) / Key Decisions / Next Steps / Critical Context / Modified Files / Relevant Files）。问题在于它按**工作状态**分（Done/In Progress），不按**议题**分；且对所有内容一视同仁地压缩，没有「待办蓝图必须完整保留」的非对称原则。

本方案（C1）解决这个错配：把**议题**提升为摘要的一级组织维度，并对已解决 vs 待办议题实施**非对称保留**——已解决极简为一行结论，待办完整保留描述/约束/相关文件。纯 prompt 层改造，不引入议题元数据。

## 2. 目标

| # | 目标 | 验收 |
|---|------|------|
| G1 | 摘要以议题为一级维度组织 | `buildCompactionPrompt` 输出顶层 `## Agenda` 议题状态表 |
| G2 | 已解决议题极简、待办议题完整保留（非对称） | prompt 明确写出非对称保留指令；测试覆盖该指令存在 |
| G3 | 移除与 Agenda 冗余的 Progress / Next Steps 章节 | prompt 模板与测试均不含这两个章节 |
| G4 | 增量摘要模式兼容议题状态语义 | 增量 header 指令引导「已解决→✅并压缩、新增议题补入、未解决保持不变」 |
| G5 | 零结构改动 | 不碰 DB schema、session entry tag、前端；改动限于 `compaction.ts` + `compaction.test.ts` |

## 3. 非目标（YAGNI）

- **不引入议题元数据**：议题识别完全靠 LLM 在摘要时从对话推断。元数据驱动（todo item / segment 信号锚定议题）是**方案 B（议题折叠）**的职责。
- **不改切点逻辑**：`findSafeCutPoint` / `findKeepRecentStart` 保持不变。待办议题"永驻不被压"的切点保护是**方案 A（议题锚定）**的职责。
- **不改触发机制**：仍由 `shouldCompact`（token 阈值）或 `/compact` 手动触发。议题完成时主动触发定向折叠是方案 B。
- **不改前端**：摘要展示逻辑不变（摘要仍作为 `compaction` entry 的 summary 文本展示）。
- **不保证议题识别 100% 准确**：LLM 推断是近似，C 阶段接受这一权衡。

## 4. 架构

### 4.1 改动范围

本方案是单函数级改造，改动面极小：

```
src/session/compaction.ts       ← 重写 buildCompactionPrompt（header + 章节模板）
src/session/compaction.test.ts  ← 更新 buildCompactionPrompt 的断言
```

不涉及：DB、schema、session entry、archive、前端、API、切点逻辑、触发逻辑。

### 4.2 prompt 模板（核心契约）

`buildCompactionPrompt(messages, previousSummary?)` 根据 `previousSummary` 是否存在，走两个 header 分支，但**章节骨架相同**。

#### 从零模式（无 previousSummary）

```text
将以下对话历史压缩为一份【议题驱动】的结构化摘要。
核心原则——非对称保留：已解决的议题只留一行结论；尚未解决/待办的议题
必须完整保留其描述、约束、已尝试方向、相关文件与待确认问题，它们是后续
工作的蓝图，绝不可被稀释。

## Agenda
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
对任务重要的文件/目录路径及原因

---
对话历史：
${history}
```

#### 增量模式（有 previousSummary）

仅 header 不同，章节骨架完全相同：

```text
更新以下已有【议题驱动】摘要。重点：
- 已解决的议题：状态更新为✅并压缩为一行结论；
- 新增议题：补入 Agenda 并完整保留其描述与约束；
- 尚未解决的议题：保持其原有描述与约束不变，只叠加本轮新进展。

<previous-summary>
${previousSummary}
</previous-summary>

（以下章节骨架同从零模式：## Agenda / ## Goal / ## Constraints & Preferences /
 ## Key Decisions / ## Critical Context / ## Modified Files / ## Relevant Files）
```

### 4.3 章节变化

| 章节 | 现状 | C1 处理 | 理由 |
|------|------|---------|------|
| **`## Agenda`** | 无 | **新增（顶层骨架）** | 议题成为一级维度，C1 的核心 |
| `## Progress`(Done/InProgress/Blocked) | 有 | **移除** | 与 Agenda 冗余——议题状态已含 done/in-progress/blocked |
| `## Next Steps` | 有 | **移除** | Agenda 的 ⏳/📋 议题按处理顺序排列即等于 next steps |
| `## Goal` | 有 | 保留 | 跨议题全局目标 |
| `## Constraints & Preferences` | 有 | 保留 | 跨议题全局约束 |
| `## Key Decisions` | 有 | 保留 | 跨议题决策 |
| `## Critical Context` | 有 | 保留 | 技术事实附录 |
| `## Modified Files` | 有 | 保留 | 文件变更索引 |
| `## Relevant Files` | 有 | 保留 | 文件引用索引 |

### 4.4 序列化逻辑（不变）

`serializePart` / `truncateToolOutput` / `history` 的构造逻辑**完全不变**——它们负责把 Message[] 序列化为 prompt 末尾的「对话历史」文本。C1 只改 header 和章节骨架，不碰序列化。

### 4.5 增量摘要兼容性

现有增量机制（`findPreviousSummary` + `previousSummary` 参数）天然兼容：

- 连续多次压缩时，议题表跨轮迭代更新——已解决的会被标 ✅ 并压缩，新增议题补入。
- `findPreviousSummary` 逻辑不变（仍取最新 `compaction` entry 的 summary）。
- 唯一变化：增量 header 指令从「保留仍成立的细节，移除过时信息，合并新事实」改为议题状态驱动的更新指令（见 §4.2 增量模式）。

## 5. 错误处理

本方案是纯字符串构造（`buildCompactionPrompt` 是同步纯函数，不涉及 IO），无新增错误路径。`summarizer`（LLM 调用）失败仍由 `compactSession` 的现有调用方处理，C1 不改变这一层。

| 场景 | 处理 |
|------|------|
| LLM 不遵循 Agenda 格式 | C 阶段接受——这是 LLM 推断的固有近似。B 阶段用元数据锚定后会更可靠 |
| 增量模式下旧 summary 是旧格式（无 Agenda） | header 指令引导 LLM 将其重构为议题驱动格式；`findPreviousSummary` 仍照常取最新 summary |

## 6. 测试策略

测试归入现有 `src/session/compaction.test.ts` 的 `describe('buildCompactionPrompt')` block（遵循「修 bug/feature 时优先归入已有测试文件」规范）。

现有 5 个用例需更新（它们断言旧章节头），并新增议题相关用例：

**更新**：
- `includes section headers and entry content`：断言 `## Agenda` 存在（替代 `## Goal`/`## Progress` 单独断言），确认 `## Goal`/`## Key Decisions` 等保留章节仍在。
- 增量摘要用例：断言新的议题状态更新指令文本（"已解决的议题：状态更新为✅"等），替代旧的"更新以下已有摘要"断言。同时验证从零模式仍含"将以下对话历史压缩为一份【议题驱动】的结构化摘要"。
- 从零 vs 增量的分支断言保持（previousSummary 真值走增量、否则从零）。

**新增**：
- `移除 Progress 和 Next Steps 章节`：断言 prompt 不含 `## Progress`、`## Next Steps`。
- `非对称保留指令存在`：从零模式断言 prompt 含"已解决的议题只留一行结论"与"必须完整保留"。
- `Agenda 章节含状态标记指引`：断言 prompt 含 `✅已解决 / ⏳进行中 / 🔒阻塞 / 📋待办`。

序列化相关用例（截断 `[truncated]`、`serializePart`）**不变**——C1 不碰序列化逻辑。

## 7. 关键文件清单

| 文件 | 改动 |
|------|------|
| `src/session/compaction.ts` | 重写 `buildCompactionPrompt`：两个 header 分支 + 章节骨架（新增 `## Agenda`，移除 `## Progress` / `## Next Steps`）。`serializePart`/`truncateToolOutput`/`messageTokens`/`findKeepRecentStart`/`findPreviousSummary`/`compactSession` 均不变 |
| `src/session/compaction.test.ts` | 更新 `buildCompactionPrompt` 的 5 个现有断言；新增 3 个议题相关用例 |

## 8. 与后续方案 B / A 的关系

本 spec 是「状态驱动压缩」三阶段路径的第一阶段。三者递进、互补：

| 阶段 | 解决的问题 | 机制 | 依赖 |
|------|-----------|------|------|
| **C1（本 spec）** | 传统压缩把待办蓝图压糊 | 改 prompt：议题驱动 + 非对称保留 | 无（纯 prompt） |
| **B 议题折叠（后续）** | 已闭环议题的讨论仍逐字占用上下文 | 议题完成时主动触发定向压缩（折叠该议题子线程）；复用 todo done / segment `user_confirmed` 信号锚定议题 | 议题 ↔ 消息范围的关联（新元数据） |
| **A 议题锚定（后续）** | 全局压缩误伤待办议题蓝图 | 切点逻辑引入 pinned 集合：被标记为待办议题的消息永驻，无论多老 | 议题元数据（与 B 共享） |

B 和 A 在 C1 完成后各自独立 brainstorm，不在本 spec 范围内。

C1 与现有 shake（`2026-07-08-shake-compaction-design.md`）正交：shake 是零 LLM 的机械裁剪，C1 是 LLM 摘要的 prompt 改造，两者可叠加（先 shake 重内容，再 compaction 摘要，摘要内容更少、议题表更聚焦）。
