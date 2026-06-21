# Session & Compaction 详细设计

> 基于 pi、opencode、oh-my-pi/snapcompact 的实现分析。

## 1. 参考项目分析

### 1.1 Pi（harness/session）

**Session 数据结构**：树形 DAG，typed entries（message、compaction、branch_summary、custom 等），JSONL 追加存储。

**Compaction**：`prepareCompaction()` 找安全切割点，`compact()` 调用 LLM 生成结构化摘要（Goal/Progress/Decisions/Next Steps/Critical Context），保留最近 N 条原文。

**Branch**：`forkSession()` 复制路径到新 session，`branch_summary` 记录分支原因。

### 1.2 OpenCode（session/）

扁平 SQLite 表，LLM 回放压缩，overflow 自动裁剪。

### 1.3 Oh-My-Pi（snapcompact）

位图压缩：渲染历史为 PNG 图片，视觉模型直接"看"图片。零 API 调用，确定性输出。

---

## 2. c0de-agent Session 设计

### 2.1 架构

```
src/session/
├── session.ts         Session CRUD + 树操作
├── entry.ts           Entry 类型和操作
├── context.ts         上下文重建
├── branch.ts          分支管理
├── squash.ts          Squash 压缩（类似 git merge --squash）
├── snapshot.ts        源码快照管理
├── archive.ts         压缩窗口归档（可搜索/可引用）
├── compaction/
│   ├── types.ts       Compaction 接口
│   ├── llm.ts         LLM 摘要策略
│   ├── bitmap.ts      位图压缩策略
│   ├── squash.ts      Squash 策略
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
  parentId: string | null
  branchPoint: string | null
  metadata: SessionMetadata
  createdAt: number
  updatedAt: number
}

type SessionMetadata = {
  mainThreadId?: string     // 主线程 session ID（用于 squash 回归）
  squashCount?: number      // 被 squash 的次数
  fileSnapshots?: string[]  // 关联的文件快照 ID 列表
}

type SessionEntry =
  | { _tag: 'message'; id: string; sessionId: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: number }
  | { _tag: 'tool_call'; id: string; sessionId: string; tool: string; input: unknown; timestamp: number }
  | { _tag: 'tool_result'; id: string; sessionId: string; tool: string; output: ToolResult; timestamp: number }
  | { _tag: 'compaction'; id: string; sessionId: string; summary: string; originalEntryIds: string[]; archiveId: string; tokenCount: number; timestamp: number }
  | { _tag: 'squash'; id: string; sessionId: string; summary: string; squashedSessionIds: string[]; archiveId: string; tokenCount: number; timestamp: number }
  | { _tag: 'branch_summary'; id: string; sessionId: string; summary: string; sourceSessionId: string; timestamp: number }
  | { _tag: 'steering'; id: string; sessionId: string; content: string; timestamp: number }
  | { _tag: 'file_snapshot'; id: string; sessionId: string; path: string; content: string; hash: string; tokenCount: number; timestamp: number }
```

### 2.3 存储

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
  tag TEXT NOT NULL,
  role TEXT,
  content JSONB NOT NULL,
  tool_name TEXT,
  token_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_entries_session ON session_entries(session_id, created_at);

-- 压缩归档表（存储原始会话信息，可搜索）
CREATE TABLE compaction_archives (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id),
  compaction_id UUID NOT NULL,     -- 关联的 compaction/squash entry ID
  archive_type TEXT NOT NULL,      -- 'compaction' | 'squash'
  original_entries JSONB NOT NULL, -- 被压缩的原始 entries 完整数据
  file_snapshots JSONB DEFAULT '[]', -- 压缩时的文件快照列表
  summary TEXT NOT NULL,           -- 摘要文本
  token_count INTEGER,
  searchable_text TEXT,            -- 全文搜索用的纯文本
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_archives_session ON compaction_archives(session_id);
CREATE INDEX idx_archives_search ON compaction_archives USING gin(to_tsvector('english', searchable_text));

-- 文件快照表（热点源码的最新快照）
CREATE TABLE file_snapshots (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id),
  entry_id UUID,                   -- 关联的 entry
  file_path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1,       -- 同一文件的版本号
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_snapshots_session_path ON file_snapshots(session_id, file_path);
CREATE UNIQUE INDEX idx_snapshots_latest ON file_snapshots(session_id, file_path, version DESC);
```

### 2.4 Squash 压缩（类似 git merge --squash）

将最近的 N 次交互压缩为摘要，保持缓存前缀不变，回归主线任务：

```typescript
type SquashConfig = {
  keepRecent: number           // 保留最近 N 条原文
  preserveFileSnapshots: boolean // 保留热点文件快照
  archiveOriginal: boolean     // 归档原始 entries（可搜索/可引用）
}

// Squash 最近的交互到栈顶
// 类似 git rebase -i + squash：把多个 commit 合并为一个
export async function squashRecent(
  db: DB,
  sessionId: string,
  count: number,               // 压缩最近 N 条交互
  config: SquashConfig,
  compactionModel: { provider: string; model: string }
): Promise<SessionEntry> {
  const entries = getEntries(db, sessionId)
  const toSquash = entries.slice(-count)
  const remaining = entries.slice(0, -count)

  // 1. 生成 squash 摘要
  const summary = await generateSquashSummary(toSquash, compactionModel)

  // 2. 归档原始 entries
  const archiveId = await archiveOriginalEntries(db, sessionId, toSquash, 'squash')

  // 3. 保留热点文件快照
  if (config.preserveFileSnapshots) {
    const hotFiles = extractHotFiles(toSquash)
    for (const file of hotFiles) {
      await upsertFileSnapshot(db, sessionId, file.path, file.content)
    }
  }

  // 4. 创建 squash entry（放在压缩位置，保持前缀不变）
  const squashEntry: SessionEntry = {
    _tag: 'squash',
    id: generateId(),
    sessionId,
    summary,
    squashedSessionIds: toSquash.filter(e => e._tag === 'message').map(e => e.id),
    archiveId,
    tokenCount: estimateTokens(summary),
    timestamp: Date.now()
  }

  // 5. 替换 entries：保留前缀 + squash 摘要 + 最近 N 条
  const newEntries = [...remaining, squashEntry, ...entries.slice(-config.keepRecent)]
  await replaceEntries(db, sessionId, newEntries)

  return squashEntry
}

// Squash 后回归主线任务
export async function squashAndReturnToMain(
  db: DB,
  currentSessionId: string,
  mainThreadId: string,
  count: number
): Promise<void> {
  // 1. Squash 当前会话的最近交互
  await squashRecent(db, currentSessionId, count, { keepRecent: 2, preserveFileSnapshots: true, archiveOriginal: true }, compactionModel)

  // 2. 将 squash 摘要复制到主线程
  const squashEntry = getLatestSquashEntry(db, currentSessionId)
  await appendEntry(db, mainThreadId, {
    ...squashEntry,
    sessionId: mainThreadId,
    content: `[Squashed from ${currentSessionId}]\n${squashEntry.summary}`
  })

  // 3. 复制热点文件快照到主线程
  const snapshots = getFileSnapshots(db, currentSessionId)
  for (const snapshot of snapshots) {
    await upsertFileSnapshot(db, mainThreadId, snapshot.filePath, snapshot.content)
  }
}
```

**Squash 摘要 Prompt**：
```
将以下最近的交互压缩为简洁摘要，保留关键决策和上下文，丢弃冗余细节。
重点保留：修改了哪些文件、做了什么决策、当前进度、下一步计划。

输出格式：
## 最近操作
[简要描述做了什么]

## 修改的文件
- path: 变更描述

## 关键决策
[做出的重要决策]

## 当前状态
[进度和下一步]

---
交互历史：
{entries}
```

### 2.5 源码快照管理

压缩时保持热点源码的最新快照在上下文中，防止重复调用 read 工具：

```typescript
// 提取热点文件（被多次读取/编辑的文件）
function extractHotFiles(entries: SessionEntry[]): { path: string; content: string; tokenCount: number }[] {
  const fileAccessCount: Map<string, { count: number; lastContent?: string }> = new Map()

  for (const entry of entries) {
    if (entry._tag === 'tool_call' && (entry.tool === 'read' || entry.tool === 'write' || entry.tool === 'edit')) {
      const input = entry.input as { path: string }
      const record = fileAccessCount.get(input.path) ?? { count: 0 }
      record.count++
      fileAccessCount.set(input.path, record)
    }
    // 记录最后一次写入的内容
    if (entry._tag === 'tool_result' && entry.tool === 'read') {
      const input = entries.find(e => e._tag === 'tool_call' && e.id === entry.id)?.input as { path: string }
      if (input) {
        const record = fileAccessCount.get(input.path) ?? { count: 0 }
        record.lastContent = entry.output
        fileAccessCount.set(input.path, record)
      }
    }
  }

  // 按访问次数排序，取 top N
  return Array.from(fileAccessCount.entries())
    .filter(([_, v]) => v.count >= 2 && v.lastContent)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([path, v]) => ({ path, content: v.lastContent!, tokenCount: estimateTokens(v.lastContent!) }))
}

// 上下文重建时注入文件快照
function injectFileSnapshots(messages: ChatMessage[], snapshots: FileSnapshot[]): ChatMessage[] {
  if (snapshots.length === 0) return messages

  const snapshotBlock = snapshots.map(s =>
    `[Cached File: ${s.filePath}]\n\`\`\`\n${s.content}\n\`\`\``
  ).join('\n\n')

  // 在 system prompt 后注入，保持缓存前缀稳定
  return [
    messages[0], // system prompt
    { role: 'system', content: `[Active File Snapshots - DO NOT re-read these files]\n${snapshotBlock}` },
    ...messages.slice(1)
  ]
}

// 读取工具检查：如果文件已有快照，直接返回快照而不是重新读取
function checkFileSnapshot(db: DB, sessionId: string, filePath: string): string | null {
  const snapshot = getLatestFileSnapshot(db, sessionId, filePath)
  return snapshot?.content ?? null
}
```

### 2.6 压缩归档（可搜索/可引用）

每个压缩窗口的原始会话信息存储在 `compaction_archives` 表中，支持：

```typescript
// 搜索归档内容
export function searchArchives(db: DB, sessionId: string, query: string): CompactionArchive[] {
  return db.select()
    .from(compactionArchives)
    .where(
      and(
        eq(compactionArchives.sessionId, sessionId),
        sql`to_tsvector('english', ${compactionArchives.searchableText}) @@ plainto_tsquery('english', ${query})`
      )
    )
    .orderBy(desc(compactionArchives.createdAt))
    .execute()
}

// 获取归档详情（用于 @ 引用）
export function getArchive(db: DB, archiveId: string): CompactionArchive {
  return db.select()
    .from(compactionArchives)
    .where(eq(compactionArchives.id, archiveId))
    .execute()
}

// 获取归档的原始 entries（用于 @ 引用查看完整历史）
export function getArchiveOriginalEntries(db: DB, archiveId: string): SessionEntry[] {
  const archive = getArchive(db, archiveId)
  return archive.originalEntries as SessionEntry[]
}
```

**用户 @ 引用**：

用户在聊天中可以通过 `@[archive:<id>]` 或 `@[squash:<n>]` 引用压缩窗口：

```typescript
// 解析 @ 引用
function parseArchiveReference(text: string): { type: 'archive' | 'squash'; id: string } | null {
  // @[archive:abc123] → 引用特定归档
  // @[squash:1] → 引用最近第 1 次 squash
  // @[squash:last] → 引用最近一次 squash
  const archiveMatch = text.match(/@\[archive:([^\]]+)\]/)
  if (archiveMatch) return { type: 'archive', id: archiveMatch[1] }

  const squashMatch = text.match(/@\[squash:(\d+|last)\]/)
  if (squashMatch) return { type: 'squash', id: squashMatch[1] }

  return null
}

// 将 @ 引用解析为上下文内容
export async function resolveArchiveReference(db: DB, sessionId: string, ref: ReturnType<typeof parseArchiveReference>): Promise<string | null> {
  if (!ref) return null

  if (ref.type === 'archive') {
    const archive = getArchive(db, ref.id)
    return archive ? `[Referenced Archive]\n${archive.summary}\n\nOriginal entries available via /archive ${ref.id}` : null
  }

  if (ref.type === 'squash') {
    const archives = db.select()
      .from(compactionArchives)
      .where(and(eq(compactionArchives.sessionId, sessionId), eq(compactionArchives.archiveType, 'squash')))
      .orderBy(desc(compactionArchives.createdAt))
      .execute()

    const index = ref.id === 'last' ? 0 : parseInt(ref.id) - 1
    const archive = archives[index]
    return archive ? `[Referenced Squash #${index + 1}]\n${archive.summary}` : null
  }

  return null
}
```

### 2.7 Compaction 接口

```typescript
type CompactionStrategy = {
  name: string
  shouldCompact(entries: SessionEntry[], budget: TokenBudget): boolean
  prepareCompaction(entries: SessionEntry[], budget: TokenBudget): CompactionPlan
  compact(plan: CompactionPlan, model: { provider: string; model: string }): Promise<CompactionResult>
}

type CompactionPlan = {
  keepEntries: SessionEntry[]
  compactEntries: SessionEntry[]
  hotFiles: { path: string; content: string }[]  // 需要保留的热点文件
  cutPoint: number
}

type CompactionResult = {
  summary: string
  tokenCount: number
  originalEntryIds: string[]
  archiveId: string              // 归档 ID（可搜索/可引用）
  fileSnapshots: string[]        // 保留的文件快照 ID
}
```

### 2.8 LLM 摘要策略

```typescript
const llmStrategy: CompactionStrategy = {
  name: 'llm',

  shouldCompact(entries, budget) {
    const usedTokens = entries.reduce((sum, e) => sum + e.tokenCount, 0)
    return usedTokens > budget.total * 0.8
  },

  prepareCompaction(entries, budget) {
    const keepRecentTokens = budget.total * 0.3
    let kept = 0
    const keepFrom = entries.findLastIndex(e => { kept += e.tokenCount; return kept >= keepRecentTokens })
    const safeCutPoint = findSafeCutPoint(entries, keepFrom)

    // 提取热点文件
    const hotFiles = extractHotFiles(entries.slice(0, safeCutPoint))

    return {
      keepEntries: entries.slice(safeCutPoint),
      compactEntries: entries.slice(0, safeCutPoint),
      hotFiles,
      cutPoint: safeCutPoint
    }
  },

  async compact(plan, model) {
    const prompt = buildCompactionPrompt(plan.compactEntries)
    const summary = await llm.chat(prompt, model)
    const archiveId = await archiveOriginalEntries(db, sessionId, plan.compactEntries, 'compaction')

    // 保留热点文件快照
    const snapshotIds: string[] = []
    for (const file of plan.hotFiles) {
      const id = await upsertFileSnapshot(db, sessionId, file.path, file.content)
      snapshotIds.push(id)
    }

    return {
      summary,
      tokenCount: estimateTokens(summary),
      originalEntryIds: plan.compactEntries.map(e => e.id),
      archiveId,
      fileSnapshots: snapshotIds
    }
  }
}
```

**摘要 Prompt 模板**：
```
将以下对话历史压缩为结构化摘要。保留关键信息，丢弃冗余细节。

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

## Modified Files
修改过的文件列表及变更摘要

---
对话历史：
{entries}
```

### 2.9 安全切割点

```typescript
function findSafeCutPoint(entries: SessionEntry[], preferredCut: number): number {
  for (let i = preferredCut; i >= 0; i--) {
    const entry = entries[i]
    const nextEntry = entries[i + 1]
    if (entry._tag === 'message' && (!nextEntry || nextEntry._tag === 'message' || nextEntry._tag === 'compaction')) return i
    if (entry._tag === 'tool_result' && nextEntry?._tag === 'message') return i + 1
  }
  return 0
}
```

### 2.10 分支管理

```typescript
export function forkSession(db: DB, sessionId: string, entryId: string): Session {
  const entries = getEntries(db, sessionId)
  const forkIndex = entries.findIndex(e => e.id === entryId)
  const entriesToCopy = entries.slice(0, forkIndex + 1)
  const newSession = createSession(db, `Branch from ${sessionId}`)
  for (const entry of entriesToCopy) {
    appendEntry(db, { ...entry, id: generateId(), sessionId: newSession.id })
  }
  appendEntry(db, {
    _tag: 'branch_summary', id: generateId(), sessionId: newSession.id,
    summary: `Branched from session ${sessionId} at entry ${entryId}`,
    sourceSessionId: sessionId, timestamp: Date.now()
  })
  return newSession
}
```

### 2.11 Token 估算

```typescript
export function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const otherChars = text.length - cjkChars
  return Math.ceil(cjkChars * 2 + otherChars / 4)
}

// 使用 provider 报告的实际 usage 校准
export function calibrateEstimate(model: string, actual: { input: number; output: number }, estimated: number): void {
  // 存储校准因子
}
```

### 2.12 上下文重建

```typescript
export function buildSessionContext(db: DB, sessionId: string): SessionEntry[] {
  return getEntries(db, sessionId)
}

export function entriesToMessages(db: DB, entries: SessionEntry[], sessionId: string): ChatMessage[] {
  const messages: ChatMessage[] = []

  for (const entry of entries) {
    switch (entry._tag) {
      case 'message':
        messages.push({ role: entry.role, content: entry.content })
        break
      case 'tool_call':
        // 附加到上一条 assistant 消息
        break
      case 'tool_result':
        messages.push({ role: 'tool', toolCallId: entry.id, content: JSON.stringify(entry.output) })
        break
      case 'compaction':
      case 'squash':
        messages.push({ role: 'system', content: `[Compacted History]\n${entry.summary}` })
        break
      case 'branch_summary':
        messages.push({ role: 'system', content: `[Branch Context]\n${entry.summary}` })
        break
      case 'steering':
        messages.push({ role: 'system', content: entry.content })
        break
      case 'file_snapshot':
        // 文件快照不直接放入消息，由 snapshot 管理器处理
        break
    }
  }

  // 注入热点文件快照
  const snapshots = getFileSnapshots(db, sessionId)
  return injectFileSnapshots(messages, snapshots)
}
```
