# Session & Compaction 详细设计

> 基于 pi、opencode、oh-my-pi/snapcompact 的实现分析。

## 1. 参考项目分析

### 1.1 Pi（harness/session）

**Session 数据结构**：树形 DAG
- 每个 session 是一棵树，节点是 typed entries（message、compaction、branch_summary、custom 等）
- 通过 `parentId` 链接形成树结构
- `buildSessionContext()` 从根到当前叶子重建完整上下文

**Entry 类型**：
```typescript
type SessionEntry =
  | { _tag: 'message'; role: 'user' | 'assistant'; content: string }
  | { _tag: 'compaction'; summary: string; tokenCount: number }
  | { _tag: 'branch_summary'; summary: string; branchPath: string }
  | { _tag: 'tool_call'; tool: string; input: unknown }
  | { _tag: 'tool_result'; tool: string; output: unknown }
  | { _tag: 'custom'; kind: string; data: unknown }
```

**存储**：JSONL 文件，每行一个 entry。追加写入，不修改历史。

**分支**：`forkSession()` 复制从根到目标 entry 的路径到新 session，添加 `branch_summary` entry 记录分支原因。

**Compaction 策略**：LLM 摘要
- 触发条件：token 使用率超过阈值（默认 80%）
- `prepareCompaction()` 找到安全切割点（不在工具调用中间）
- `compact()` 调用 LLM 生成结构化摘要（Goal/Progress/Decisions/Next Steps/Critical Context）
- 摘要替换原始消息，保留最近 N 条原文

### 1.2 OpenCode（session/）

**Session 数据结构**：扁平表
- SQLite 存储，`sessions` 表 + `messages` 表
- 消息通过 `sessionId` 关联
- 无原生树结构，分支通过复制 session 实现

**Compaction 策略**：LLM 回放
- `compaction.ts`（610行）实现压缩逻辑
- 触发条件：消息数超过阈值或 token 超限
- 策略：选择保留最近 N 轮对话，将更早的消息发送给 LLM 生成摘要
- 摘要作为 system message 插入消息流开头

**Overflow 处理**：
- `overflow.ts` 检测 context 是否超限
- 自动裁剪最旧的消息

### 1.3 Oh-My-Pi（snapcompact）

**创新方案**：位图压缩
- 不用 LLM 生成摘要，而是将历史消息渲染为终端风格的 PNG 图片
- 视觉模型（Claude、GPT-4V）可以直接"看"图片理解历史
- 本地确定性处理，不需要 API 调用

**实现细节**：
- 使用 Rust 原生渲染器（pi-natives）生成 PNG
- Provider 感知的帧形状：Anthropic `11on16-bw`、Google/OpenAI `8on22-bw`
- 文本归一化、像素字体光栅化
- 帧预算：每个 provider 限制图片 token 数
- 最旧优先淘汰策略
- 文本尾部回退：最近的消息保留原文

**优势**：
- 零 API 调用成本
- 确定性（相同输入总是相同输出）
- 保留视觉格式（代码缩进、表格等）

**劣势**：
- 只适用于支持视觉的模型
- 图片 token 成本可能高于文本摘要
- 实现复杂度高（需要 Rust 渲染器）

---

## 2. c0de-agent Session 设计

### 2.1 架构

采用 pi 的树形 DAG 结构，支持两种可切换的 compaction 策略。

```
src/session/
├── session.ts         Session CRUD + 树操作
├── entry.ts           Entry 类型和操作
├── context.ts         上下文重建
├── branch.ts          分支管理
├── compaction/
│   ├── types.ts       Compaction 接口
│   ├── llm.ts         LLM 摘要策略
│   ├── bitmap.ts      位图压缩策略（可选，需要视觉模型）
│   └── index.ts       策略选择
├── token.ts           Token 估算
├── storage.ts         存储抽象
├── types.ts           类型定义
└── index.ts
```

### 2.2 Session 树

```typescript
type Session = {
  id: string
  title: string
  parentId: string | null      // 父 session（分支来源）
  branchPoint: string | null   // 分支点 entry ID
  createdAt: number
  updatedAt: number
}

type SessionEntry =
  | { _tag: 'message'; id: string; sessionId: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: number }
  | { _tag: 'tool_call'; id: string; sessionId: string; tool: string; input: unknown; timestamp: number }
  | { _tag: 'tool_result'; id: string; sessionId: string; tool: string; output: ToolResult; timestamp: number }
  | { _tag: 'compaction'; id: string; sessionId: string; summary: string; originalEntryIds: string[]; tokenCount: number; timestamp: number }
  | { _tag: 'branch_summary'; id: string; sessionId: string; summary: string; sourceSessionId: string; timestamp: number }
  | { _tag: 'steering'; id: string; sessionId: string; content: string; timestamp: number }

// 上下文重建：从根到当前叶子收集所有 entries
export function buildSessionContext(db: DB, sessionId: string): SessionEntry[]

// 分支：从指定 entry 处创建新 session
export function forkSession(db: DB, sessionId: string, entryId: string): Session

// 获取分支树
export function getSessionTree(db: DB): SessionTreeNode[]
```

### 2.3 存储

使用 Drizzle ORM + PGLite/PostgreSQL：

```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  parent_id UUID REFERENCES sessions(id),
  branch_point UUID,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE session_entries (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id),
  tag TEXT NOT NULL,           -- 'message' | 'tool_call' | 'tool_result' | 'compaction' | 'branch_summary' | 'steering'
  role TEXT,                   -- 仅 message 类型
  content JSONB NOT NULL,      -- 结构化内容
  tool_name TEXT,              -- 仅 tool_call/tool_result 类型
  token_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_entries_session ON session_entries(session_id, created_at);
```

### 2.4 Compaction 接口

```typescript
type CompactionStrategy = {
  name: string

  // 检查是否需要压缩
  shouldCompact(entries: SessionEntry[], budget: TokenBudget): boolean

  // 准备压缩（找到切割点）
  prepareCompaction(entries: SessionEntry[], budget: TokenBudget): CompactionPlan

  // 执行压缩
  compact(plan: CompactionPlan): Promise<CompactionResult>
}

type CompactionPlan = {
  keepEntries: SessionEntry[]      // 保留原文的 entries
  compactEntries: SessionEntry[]   // 需要压缩的 entries
  cutPoint: number                 // 切割点索引
}

type CompactionResult = {
  summary: string                  // 压缩后的摘要
  tokenCount: number               // 摘要 token 数
  originalEntryIds: string[]       // 被压缩的 entry IDs
}

// 策略注册
export function registerCompactionStrategy(name: string, strategy: CompactionStrategy): void
export function getCompactionStrategy(name: string): CompactionStrategy
```

### 2.5 LLM 摘要策略

```typescript
const llmStrategy: CompactionStrategy = {
  name: 'llm',

  shouldCompact(entries, budget) {
    const usedTokens = entries.reduce((sum, e) => sum + e.tokenCount, 0)
    return usedTokens > budget.total * 0.8
  },

  prepareCompaction(entries, budget) {
    // 保留最近 keepRecentTokens 的消息原文
    const keepRecentTokens = budget.total * 0.3
    let kept = 0
    const keepFrom = entries.findLastIndex(e => {
      kept += e.tokenCount
      return kept >= keepRecentTokens
    })

    // 找安全切割点（不在工具调用中间）
    const safeCutPoint = findSafeCutPoint(entries, keepFrom)

    return {
      keepEntries: entries.slice(safeCutPoint),
      compactEntries: entries.slice(0, safeCutPoint),
      cutPoint: safeCutPoint
    }
  },

  async compact(plan) {
    // 调用 LLM 生成结构化摘要
    const prompt = buildCompactionPrompt(plan.compactEntries)
    const summary = await llm.chat(prompt)
    return {
      summary,
      tokenCount: estimateTokens(summary),
      originalEntryIds: plan.compactEntries.map(e => e.id)
    }
  }
}
```

**摘要 Prompt 模板**：
```
将以下对话历史压缩为结构化摘要。保留关键信息，丢弃冗余细节。

输出格式：
## Goal
用户的目标是什么

## Progress
已完成的工作

## Decisions
做出的关键决策

## Next Steps
接下来要做什么

## Critical Context
必须记住的上下文（文件路径、变量名、错误信息等）

---
对话历史：
{entries}
```

### 2.6 安全切割点

```typescript
function findSafeCutPoint(entries: SessionEntry[], preferredCut: number): number {
  // 不能在 tool_call 和 tool_result 之间切割
  // 不能在 assistant 消息的 tool_calls 和后续 tool_result 之间切割
  // 向前找到最近的安全位置

  for (let i = preferredCut; i >= 0; i--) {
    const entry = entries[i]
    const nextEntry = entries[i + 1]

    // 安全：message 后面是 message 或 compaction
    if (entry._tag === 'message' && (!nextEntry || nextEntry._tag === 'message' || nextEntry._tag === 'compaction')) {
      return i
    }
    // 安全：tool_result 后面是 message
    if (entry._tag === 'tool_result' && nextEntry?._tag === 'message') {
      return i + 1
    }
  }

  return 0 // 最坏情况从头切割
}
```

### 2.7 分支管理

```typescript
// 从指定 entry 处创建分支
export function forkSession(db: DB, sessionId: string, entryId: string): Session {
  const entries = getEntries(db, sessionId)
  const forkIndex = entries.findIndex(e => e.id === entryId)
  const entriesToCopy = entries.slice(0, forkIndex + 1)

  // 创建新 session
  const newSession = createSession(db, `Branch from ${sessionId}`)

  // 复制 entries
  for (const entry of entriesToCopy) {
    appendEntry(db, { ...entry, id: generateId(), sessionId: newSession.id })
  }

  // 添加分支摘要
  appendEntry(db, {
    _tag: 'branch_summary',
    id: generateId(),
    sessionId: newSession.id,
    summary: `Branched from session ${sessionId} at entry ${entryId}`,
    sourceSessionId: sessionId,
    timestamp: Date.now()
  })

  return newSession
}
```

### 2.8 Token 估算

```typescript
// 简单启发式：4 字符 ≈ 1 token（英文）
// 中文：1 字 ≈ 2 tokens
export function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const otherChars = text.length - cjkChars
  return Math.ceil(cjkChars * 2 + otherChars / 4)
}

// 使用 provider 报告的实际 usage 更新估算
export function calibrateEstimate(model: string, actual: { input: number; output: number }, estimated: number): void {
  // 存储校准因子，后续估算使用
}
```

---

## 3. 上下文重建流程

```typescript
export function buildSessionContext(db: DB, sessionId: string): SessionEntry[] {
  const session = getSession(db, sessionId)
  const entries = getEntries(db, sessionId)

  if (session.parentId && session.branchPoint) {
    // 分支 session：从父 session 复制的 entries 已经在当前 session 中
    return entries
  }

  // 主 session：直接返回所有 entries
  return entries
}

// 转换为 LLM 消息格式
export function entriesToMessages(entries: SessionEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = []

  for (const entry of entries) {
    switch (entry._tag) {
      case 'message':
        messages.push({ role: entry.role, content: entry.content })
        break
      case 'tool_call':
        // 工具调用附加到上一条 assistant 消息
        break
      case 'tool_result':
        messages.push({ role: 'tool', toolCallId: entry.id, content: JSON.stringify(entry.output) })
        break
      case 'compaction':
        messages.push({ role: 'system', content: `[Compacted History]\n${entry.summary}` })
        break
      case 'branch_summary':
        messages.push({ role: 'system', content: `[Branch Context]\n${entry.summary}` })
        break
      case 'steering':
        messages.push({ role: 'system', content: entry.content })
        break
    }
  }

  return messages
}
```
