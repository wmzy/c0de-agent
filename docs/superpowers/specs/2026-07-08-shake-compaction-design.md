# Shake 压缩：手术式机械内容裁剪

> 日期：2026-07-08
> 状态：待实现
> 关联：`modules/session-compaction`（现有 compaction/squash 基础设施）、oh-my-pi `packages/agent/src/compaction/shake.ts`

## 1. 背景

现有 compaction（`src/session/compaction.ts`）是 **LLM 摘要式**——把旧消息整体送进 LLM 生成 prose 摘要。但会话中 token 大户是**重型工具输出**（bash/read/grep 的结果，常占 70%+ token）和**大文本块**（assistant 消息里的大围栏代码块、XML 块）。这些内容一旦消费过，后续逐字回看价值很低。

oh-my-pi 的 **shake** 策略提供互补路径：**零 LLM 调用，纯机械操作**——把重内容原位替换为短占位符，结构和小内容保持不变。本设计将 shake 引入 c0de-agent，作为手动触发的压缩手段，与 LLM 摘要 compaction 并存。

## 2. 目标

| # | 目标 | 验收 |
|---|------|------|
| G1 | 后端纯逻辑层 `shake.ts` 移植 omp 的区域检测 + 原位替换 | `collectShakeRegions` + `applyShakeRegions` 纯函数，单元测试覆盖两类区域 |
| G2 | shake 的原始内容归档与 compaction 一致 | 复用 `compactionArchives` 表，`archiveType: 'shake'` |
| G3 | 两个 API：preview（计算可 shake 区域）+ apply（归档 + 持久化替换） | `POST /sessions/:id/shake/preview`、`POST /sessions/:id/shake/apply` |
| G4 | 前端 ShakePanel：开关 → preview → 勾选（全选/选当前及以下/取消全选）→ 预览效果 → 提交 | 面板渲染 region 列表，勾选后实时预览，提交后调用 apply |
| G5 | 防重复 shake：已 shaken 的区域不再出现 | `shakenAt` 标记，preview 跳过已标记内容 |

## 3. 非目标（YAGNI）

- **不做自动 shake（threshold 触发）**：先做手动触发。自动触发是后续迭代，需要配合 `compactionModel` 等配置。
- **不做 artifact 文件 offload**：归档在 `compactionArchives`，可通过 `searchArchives` / `@[archive:id]` 查回，不需独立 artifact 系统。
- **不暴露 `ShakeConfig` 到 config.json**：硬编码合理默认值，后续按需暴露。
- **不做 `/shake` slash 命令**：交互是前端面板，不需要 slash 命令。
- **不做会话内消息级 tree 导航**：独立子系统，shake 完成后单独 brainstorming。

## 4. 架构

### 4.1 模块布局

```
src/session/shake.ts          ← 纯逻辑层（移植 omp，适配 flat Message[]）
src/session/shake.test.ts      ← 单元测试（新文件，注明来源）
src/session/archive.ts         ← archiveOriginalEntries 的 archiveType 加 'shake'
src/shared/types/tool.ts       ← ToolResult 加 shakenAt
src/shared/types/message.ts    ← MessageContent 无改动（tool_result 携带 ToolResult）
src/server/routes/session.ts   ← 加 2 个 endpoint
src/server/routes/session.test.ts ← 加集成测试（归入已有文件）
src/web/services/session.ts    ← 加 shake API client
src/web/components/ShakePanel.tsx ← 新组件
src/web/views/Chat.tsx         ← 接 Shake 开关按钮
```

### 4.2 数据模型

**ShakeRegion**（纯逻辑层中间结构）：

```typescript
type ShakeRegion =
  | {
      kind: 'toolResult'
      id: string                  // `${messageId}:toolResult:${partIndex}`
      messageId: string
      messageIndex: number        // Message[] 索引
      partIndex: number           // content[] 索引（tool_result part）
      tokens: number
      originalText: string        // 序列化的 output 文本
      label: string               // tool name
    }
  | {
      kind: 'block'
      id: string                  // `${messageId}:block:${partIndex}:${start}`
      messageId: string
      messageIndex: number
      partIndex: number           // text/thinking block 索引
      start: number               // 字符偏移 [start, end)
      end: number
      tokens: number
      originalText: string
      label: string               // role（'assistant' | 'user' | ...）
    }
```

**ShakeRegionView**（API 返回给前端的视图）：

```typescript
type ShakeRegionView = {
  id: string
  kind: 'toolResult' | 'block'
  messageId: string
  messageIndex: number
  tokens: number
  label: string
  preview: string                // 前 200 字符（hover 展开让用户判断）
  placeholder: string            // shake 后的占位文本
  isAfterProtectWindow: boolean  // 是否在保护窗口外（默认选中依据）
}
```

**ToolResult 扩展**（`src/shared/types/tool.ts`）：

```typescript
type ToolResult =
  | { _tag: 'success'; output: string; metadata?: Record<string, unknown>; shakenAt?: number }
  | { _tag: 'error'; error: string; shakenAt?: number }
  | { _tag: 'permission_required'; reason: string }
  | { _tag: 'truncated'; output: string; truncated: boolean; totalLines: number; shakenAt?: number }
```

`shakenAt` 字段：① 防止 preview 重复收集已 shaken 的区域；② 前端渲染时显示「已 shake」标记。

**compactionArchives 复用**：`archiveType` 联合类型从 `'compaction' | 'squash'` 扩展为 `'compaction' | 'squash' | 'shake'`。被 shake 的原始 Message entries 整体存入 `originalEntries`，`summary` 记录 `Shaken N regions, saved M tokens`。

### 4.3 核心逻辑

#### `collectShakeRegions(messages: Message[], config: ShakeConfig): ShakeRegion[]`

纯函数，移植 omp 逻辑，适配 flat `Message[]`：

1. 从新→旧累计 `accumulatedAfter[i]`（i 之后所有 message 的 token 总和）。
2. 遍历每条 message：
   - `accumulatedAfter[i] < config.protectTokens` → 跳过（保护窗口）。
   - 跳过已标记 `shakenAt` 的 tool_result（不重复 shake）。
   - 跳过 `config.protectedTools` 中的工具（默认空数组）。
3. 两类 region：
   - **toolResult**：`content[j]` 是 `_tag: 'tool_result'`，output 文本 token > `config.fenceMinTokens` → 整条 ToolResultShakeRegion。
   - **block**：遍历 `content[j]` 里的 `_tag: 'text'` / `_tag: 'thinking'` parts，`scanTextForBlockRanges(text)` 找围栏/XML 块，token > `config.fenceMinTokens` → BlockShakeRegion。
4. preview 路径：总节省 token（Σ `region.tokens - PLACEHOLDER_TOKEN_ESTIMATE`）< `config.minSavings` → 返回 `[]`（不值得一 shake）。apply 路径不受此约束——用户手动勾选的 region 一定被 shake，哪怕总节省低于 minSavings（用户已显式确认意图）。
5. 返回 regions（按 `messageIndex` + `partIndex` 排序）。

**保护窗口语义**：`accumulatedAfter[i]` 是「i 之后」的 token 总和——即 i 这条消息之后还有多少 token 是新的、活跃的。如果该值小于 `protectTokens`，说明 i 在活跃上下文窗口内，不应 shake。

**compaction 边界**：如果 session 有 compaction entry（`CompactionEntry`），边界之前的 message 已被摘要归档、不再发给 LLM，shake 跳过它们。复用 `findPreviousSummary`（已有逻辑）定位边界。

#### `scanTextForBlockRanges(text: string): Array<{ start: number; end: number }>`

从 omp 移植，~80 行纯函数：

- 逐行扫描，维护围栏开关（``` / ~~~）+ XML tag 栈。
- 围栏内抑制 XML 检测（避免误判代码块里的 XML 字面量）。
- 返回 `[{ start, end }]` 字符偏移范围（含围栏行/标签行，不含尾换行）。
- `mergeRanges`：按 start 升序，丢弃与已保留范围重叠的（嵌套时取最外层）。
- 未闭合围栏/标签不产生 range（保守策略）。

#### `applyShakeRegions(messages: Message[], regions: ShakeRegion[]): Message[]`

纯函数，返回**新数组**（不改原数组）：

1. 按 region 类型分组。
2. **toolResult region**：克隆对应 message，替换 `content[partIndex].output` 为 placeholder（`[shaken: {label}, {tokens} tokens]`），加 `shakenAt: Date.now()`。
3. **block region**：同一 text block 内按 `start` 降序 splice（避免偏移漂移）。
4. 重新计算受影响 message 的 `tokenCount`。
5. 返回新数组。

#### `ShakeConfig` 默认值

```typescript
const DEFAULT_SHAKE_CONFIG: ShakeConfig = {
  protectTokens: 16_000,
  minSavings: 4_000,
  fenceMinTokens: 400,
  protectedTools: [],
}
```

### 4.4 API

#### `POST /api/sessions/:id/shake/preview`

```
请求：空 body
响应 200：{ regions: ShakeRegionView[] }
响应 404：session 不存在
```

后端：`getMessages` → `collectShakeRegions` → 映射为 `ShakeRegionView[]`。

#### `POST /api/sessions/:id/shake/apply`

```
请求：{ regionIds: string[] }
响应 200：{ shaken: number, archiveId: string }
响应 400：regionIds 含不属于该 session 的 id，或消息已变化（regionId 不匹配）
响应 404：session 不存在
```

后端流程（镜像 compaction 的 delete+insert 模式，`compaction.ts:264-269`）：
1. `getMessages` → `collectShakeRegions` → 按 `regionIds` 过滤。
2. 校验：所有 regionIds 必须命中当前 preview 结果（原子性——部分不匹配则全部拒绝）。
3. `applyShakeRegions`（纯函数得到新 messages 副本）。
4. `archiveOriginalEntries(handle, sessionId, originalEntries, 'shake', summary, generateId())` 归档原始内容。
5. 持久化替换：收集受影响 message 的原始 id（`affectedIds`），`deleteEntriesByIds(affectedIds)` 删除旧行，再 `insertEntry` 插入 shake 后的新行。未受影响的 message 不动。这与现有 compaction 的 delete+insert 模式一致——session 层不暴露 update，统一走 delete+insert。
6. 返回 `{ shaken, archiveId }`。

### 4.5 前端交互流程

```
1. Chat 工具栏出现「Shake」按钮（闪电图标 Zap）
   ↓ 点击
2. 前端 POST /shake/preview
   ↓
3. 弹出 ShakePanel（modal 或侧滑面板）：
   - 每 region 一行：
     ☑ 勾选 | label（工具名/角色）| tokens | 预览（hover 展开 preview 文本）
   - 快捷按钮：
     [全选] — 选中所有 region
     [选当前及以下] — 选中 messageIndex ≥ 面板打开时当前消息流的 messageIndex 的所有 region（messageIndex 是完整 Message[] 的绝对索引，由 preview 返回，不受前端过滤/隐藏影响）
     [取消全选]
   - 默认勾选：isAfterProtectWindow === true 的 region
   - 底部按钮：[预览效果] [提交 Shake] [取消]
   ↓ 点「预览效果」
4. 前端纯计算：选中 region 的内容在消息流中替换为 placeholder，高亮标色，
   用户可直观看到 shake 后的消息流。
   ↓ 点「提交 Shake」
5. 前端 POST /shake/apply { regionIds: [...selected] }
   ↓
6. invalidate messages 查询 → 重新渲染（shaken 内容显示占位符 + 「已 shake」标记）
```

**ShakePanel 状态管理**：`selectedIds: Set<string>`，由快捷按钮批量操作。预览效果通过 `useMemo` 从 messages + selectedIds 纯计算渲染。

## 5. 错误处理

| 场景 | 处理 |
|------|------|
| session 不存在 | 404 NOT_FOUND |
| regionIds 含不属于该 session 的 id | 400，`部分提交成功还是全部拒绝` → **全部拒绝**（原子性） |
| apply 时 messages 已变（并发）| regionId 不匹配当前 preview → 400 + 提示「消息已变化，请重新预览」 |
| preview 返回空 regions | 前端显示「没有可 shake 的内容」 |
| apply 过程中 DB 写入失败 | 抛错，前端显示「Shake 失败，请重试」，DB 状态不变（archiveOriginalEntries 和 message 替换在同一个逻辑流程中） |

## 6. 测试策略

### 6.1 单元测试（`src/session/shake.test.ts`，新文件）

文件头注明来源：
```
// shake.ts 单元测试。新建文件（shake 是全新模块，无既有测试可归入）。
// 归并建议：如未来 shake 逻辑并入 compaction.ts，本测试归入 compaction.test.ts。
```

**collectShakeRegions**：
- 标记超出保护窗口的大 tool_result
- 保护窗口内的 tool_result 不被标记
- 已标记 `shakenAt` 的不重复标记
- `protectedTools` 被排除
- 大 fenced 代码块被标记（```...``` > fenceMinTokens）
- 大 XML 块被标记
- 围栏内 XML 不重复标记
- 节省 token < minSavings 返回空
- compaction 边界之前的 message 被跳过

**scanTextForBlockRanges**：
- 简单围栏、未闭合围栏
- 嵌套 XML、围栏内 XML

**applyShakeRegions**：
- tool_result 被替换为 placeholder + shakenAt
- block 被原位 splice
- 同一 text block 多个 region 偏移正确（降序 splice）
- 返回新数组（原数组不变）

### 6.2 集成测试（`src/server/routes/session.test.ts`，归入已有文件）

- `POST /shake/preview` 返回 region 列表
- `POST /shake/apply` 归档原始内容 + 原位替换
- apply 后再 preview，已 shaken 的不出现
- 归档记录可通过 `searchArchives` 搜到
- regionIds 含不存在的 id → 400

## 7. 关键文件清单

| 文件 | 改动 |
|------|------|
| `src/session/shake.ts` | **新建**：collectShakeRegions + applyShakeRegions + scanTextForBlockRanges + ShakeConfig/Region 类型 |
| `src/session/shake.test.ts` | **新建**：单元测试 |
| `src/shared/types/tool.ts` | ToolResult 各 variant 加 `shakenAt?: number` |
| `src/session/archive.ts` | `archiveType` 联合类型加 `'shake'`（类型层面，DB 已是 text 列） |
| `src/server/routes/session.ts` | 加 `POST /:id/shake/preview`、`POST /:id/shake/apply` |
| `src/server/routes/session.test.ts` | 追加 shake 集成测试 |
| `src/web/services/session.ts` | 加 `shakePreview`/`shakeApply` API client |
| `src/web/components/ShakePanel.tsx` | **新建**：勾选面板 + 预览 + 快捷按钮 |
| `src/web/views/Chat.tsx` | 工具栏加 Shake 按钮，接 ShakePanel |

## 8. 与现有 compaction 的关系

| 维度 | compaction（LLM 摘要） | shake（机械裁剪） |
|------|----------------------|------------------|
| 触发 | 手动 `/compact` 或自动 threshold | 手动 Shake 面板 |
| 机制 | LLM 生成 prose 摘要 | 零 LLM，原位替换为占位符 |
| 归档 | `compactionArchives` archiveType='compaction' | `compactionArchives` archiveType='shake' |
| 范围 | 整段旧消息 → 摘要 | 选中的重区域 → 占位符 |
| 信息损失 | 有损（摘要） | 无损结构保留（只删重内容） |
| 适用场景 | 上下文整体压缩 | 精确删除冗余重内容，保留结构 |

两者**互补**：用户可先 shake 掉大工具输出（零成本），再对剩余内容做 LLM compaction（成本更低，因为要摘要的内容更少）。
