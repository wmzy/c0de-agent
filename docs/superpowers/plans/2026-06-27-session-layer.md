# Session Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the session layer — conversation CRUD, message persistence, session branching/forking, file snapshot caching, compaction with LLM summarization, squash compression, searchable archives, and context reconstruction — all on top of the existing Drizzle/PGLite DB schema.

**Architecture:** Pure data+functions paradigm over the Plan 2 DB layer. Each `Message` (shared type with `content: MessageContent[]`) is stored as ONE row in `sessionEntries` with `tag: 'message'`; special entries (compaction, squash, branch_summary, steering) are separate rows with their respective tags. The `Summarizer` function is injected (not imported from the LLM package) so Plan 4 stays testable without network access and depends only on `db` + `shared`. Context reconstruction converts entries to `ChatMessage[]` for the agent loop (Plan 6).

**Tech Stack:** TypeScript 5.7+ (ESM, NodeNext, strict, `verbatimModuleSyntax`), Drizzle ORM 0.45 + PGLite, Vitest 3.x, Biome 2.x. No new runtime dependencies.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/session/types.ts` | Entry types (`CompactionEntry`, `SquashEntry`, `BranchSummaryEntry`, `SteeringEntry`), `SessionEntry` union, `MessageInput`, `HotFile`, config/result types, `Summarizer`, `ArchiveRef`, `SessionTreeNode`, `CompactionArchive`; re-exports shared `Message`/`Session` |
| `src/session/token.ts` | CJK-aware `estimateTokens`, `estimateMessageTokens` |
| `src/session/session.ts` | Session CRUD: `createSession`, `getSession`, `listSessions`, `deleteSession`, `updateSessionTitle`, `touchSession` |
| `src/session/message.ts` | Message ops: `appendMessage`, `getMessages`, `getMessageCount`, `deleteMessagesAfter`; low-level `appendEntry`, `getEntries`, `deleteEntriesByIds` |
| `src/session/branch.ts` | Branching: `forkSession`, `getBranches`, `getTree` |
| `src/session/snapshot.ts` | File snapshots: `upsertFileSnapshot`, `getFileSnapshots`, `getLatestFileSnapshot`, `checkFileSnapshot` |
| `src/session/archive.ts` | Archives: `archiveOriginalEntries`, `searchArchives`, `getArchive`, `getArchiveOriginalEntries`, `parseArchiveReference`, `resolveArchiveReference` |
| `src/session/compaction.ts` | `findSafeCutPoint`, `extractHotFiles`, `buildCompactionPrompt`, `compactSession` |
| `src/session/squash.ts` | `squashRecent`, `squashAndReturnToMain` |
| `src/session/context.ts` | `getSessionContext`, `messageToChatMessage`, `entriesToChatMessages`, `injectSnapshots` |
| `src/session/index.ts` | Public API barrel |

**Dependency chain (no cycles):**

```
types     → shared types
token     → (none)
session   → db, types
message   → db, types, token, session
branch    → db, session, message
snapshot  → db, token
archive   → db, types, token
compaction→ db, message, token, snapshot, archive, types
squash    → db, message, token, snapshot, archive, compaction, types
context   → db, message, snapshot, types, shared/llm
index     → all
```

**Design conventions (apply to every task):**
- ESM imports use `.js` extensions; all type-only imports use `import type`.
- `type` not `interface`; no classes — use plain-object types + factory functions where helpful.
- `_tag` discriminated unions for all variants. `SessionEntry` narrows via `'_tag' in entry` (special entries have `_tag`; `Message` does not).
- Context-first arg: every public function takes `handle: DB` (the full DB handle from `src/db/client.ts`) as first argument.
- All DB operations are `async` (PGLite is async). Functions return `Promise`.
- DB timestamps have microsecond precision (`now()`); do NOT set `createdAt`/`updatedAt` on insert — let the DB default them. Convert `Date → number` (`getTime()`) when returning shared types.
- Run `pnpm typecheck` after each source file; `pnpm test src/session/<file>` for each test; `pnpm biome check --write src/session/` before commits if formatting drifts.
- Import the DB handle type: `import type { DB } from '../db/client.js'`.
- Import DB tables: `import { sessions, sessionEntries, compactionArchives, fileSnapshots } from '../db/schema.js'`.
- Import Drizzle operators: `import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'`.

---

### Task 1: Types

**Files:**
- Create: `src/session/types.ts`

- [ ] **Step 1: Write `src/session/types.ts`**

```typescript
import type { ChatMessage } from '../shared/types/llm.js'
import type { Message, MessageContent, MessageRole, Session, SessionMetadata } from '../shared/types/message.js'

// Re-export shared types so consumers can import everything from the session barrel.
export type { ChatMessage, Message, MessageContent, MessageRole, Session, SessionMetadata }

/** A compaction summary entry — replaces compacted messages with a summary. */
type CompactionEntry = {
  _tag: 'compaction'
  id: string
  sessionId: string
  summary: string
  originalEntryIds: string[]
  archiveId: string
  tokenCount: number
  createdAt: number
}

/** A squash entry — compresses recent interactions into a summary. */
type SquashEntry = {
  _tag: 'squash'
  id: string
  sessionId: string
  summary: string
  squashedEntryIds: string[]
  archiveId: string
  tokenCount: number
  createdAt: number
}

/** Records that a session was forked from another. */
type BranchSummaryEntry = {
  _tag: 'branch_summary'
  id: string
  sessionId: string
  summary: string
  sourceSessionId: string
  createdAt: number
}

/** A steering instruction injected mid-conversation. */
type SteeringEntry = {
  _tag: 'steering'
  id: string
  sessionId: string
  content: string
  createdAt: number
}

/** All session entries, ordered chronologically. Narrow via `'_tag' in entry`. */
type SessionEntry = Message | CompactionEntry | SquashEntry | BranchSummaryEntry | SteeringEntry

/** Input for `appendMessage` — role + content; id/timestamps auto-generated. */
type MessageInput = {
  role: MessageRole
  content: MessageContent[]
  tokenCount?: number
}

/** A hot file detected from tool-call history. */
type HotFile = {
  path: string
  content: string
  tokenCount: number
  accessCount: number
}

/** Configuration for compaction. */
type CompactionConfig = {
  keepRecent: number
  preserveSnapshots: boolean
}

/** Result of a compaction or squash operation. */
type CompactionResult =
  | {
      compacted: true
      summary: string
      archiveId: string
      fileSnapshots: string[]
      compactedCount: number
      keptCount: number
    }
  | {
      compacted: false
      reason: 'too_few_messages' | 'nothing_to_compact'
    }

/** Configuration for squash. */
type SquashConfig = {
  keepRecent: number
  preserveFileSnapshots: boolean
  archiveOriginal: boolean
}

/** Injected summarizer — the session layer does NOT import the LLM package. */
type Summarizer = (prompt: string) => Promise<string>

/** Parsed `@[archive:<id>]` / `@[squash:<n>]` reference. */
type ArchiveRef = {
  type: 'archive' | 'squash'
  id: string
}

/** A node in the session tree. */
type SessionTreeNode = {
  session: Session
  children: SessionTreeNode[]
}

/** A decoded compaction archive row. */
type CompactionArchive = {
  id: string
  sessionId: string
  compactionId: string
  archiveType: 'compaction' | 'squash'
  originalEntries: SessionEntry[]
  summary: string
  tokenCount: number
  searchableText: string
  createdAt: number
}

/** A decoded file snapshot row. */
type FileSnapshot = {
  id: string
  sessionId: string
  filePath: string
  content: string
  contentHash: string
  tokenCount: number
  version: number
  createdAt: number
}

export type {
  ArchiveRef,
  BranchSummaryEntry,
  CompactionArchive,
  CompactionConfig,
  CompactionEntry,
  CompactionResult,
  FileSnapshot,
  HotFile,
  MessageInput,
  SessionEntry,
  SessionTreeNode,
  SquashConfig,
  SquashEntry,
  SteeringEntry,
  Summarizer,
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no errors — pure types, imports resolve)

- [ ] **Step 3: Commit**

```bash
git add src/session/types.ts
git commit -m "feat(session): add session entry types and shared type re-exports"
```

---

### Task 2: Token Estimation

**Files:**
- Create: `src/session/token.ts`
- Create: `src/session/token.test.ts`

The CJK-aware heuristic from spec §2.11: Chinese characters ≈ 2 tokens each, other characters ≈ 4 chars/token. This is more accurate than the LLM layer's plain `chars/4` for Chinese-heavy content.

- [ ] **Step 1: Write `src/session/token.test.ts`**

```typescript
import { describe, expect, it } from 'vitest'
import { estimateMessageTokens, estimateTokens } from './token.js'
import type { MessageContent } from '../shared/types/message.js'

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates English text at ~4 chars/token', () => {
    expect(estimateTokens('hello world!')).toBe(3) // 12 chars / 4 = 3
  })

  it('estimates CJK characters at ~2 tokens each', () => {
    // 4 CJK chars → 4 × 2 = 8 tokens
    expect(estimateTokens('你好世界')).toBe(8)
  })

  it('handles mixed CJK and ASCII', () => {
    // '你好' (2 CJK → 4) + 'ab' (2 ASCII → 1) = 5
    expect(estimateTokens('你好ab')).toBe(5)
  })
})

describe('estimateMessageTokens', () => {
  it('sums tokens across content parts', () => {
    const content: MessageContent[] = [
      { _tag: 'text', text: 'hello' }, // 2
      { _tag: 'thinking', text: 'world' }, // 2
    ]
    expect(estimateMessageTokens(content)).toBe(4)
  })

  it('handles tool_call parts by stringifying input', () => {
    const content: MessageContent[] = [
      { _tag: 'tool_call', id: 't1', tool: 'read', input: { path: '/a.ts' } },
    ]
    expect(estimateMessageTokens(content)).toBeGreaterThan(0)
  })

  it('handles tool_result parts by stringifying output', () => {
    const content: MessageContent[] = [
      {
        _tag: 'tool_result',
        id: 't1',
        tool: 'read',
        output: { _tag: 'success', output: 'file content here' },
      },
    ]
    expect(estimateMessageTokens(content)).toBeGreaterThan(0)
  })

  it('returns 0 for empty content', () => {
    expect(estimateMessageTokens([])).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/session/token.test.ts`
Expected: FAIL — `Cannot find module './token.js'`

- [ ] **Step 3: Write `src/session/token.ts`**

```typescript
import type { MessageContent } from '../shared/types/message.js'

/**
 * CJK-aware token estimate.
 * Chinese/CJK characters ≈ 2 tokens each (denser encoding).
 * Other characters ≈ 4 chars/token (standard heuristic).
 */
const estimateTokens = (text: string): number => {
  if (text.length === 0) return 0
  const cjkCount = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0
  const otherCount = text.length - cjkCount
  return Math.ceil(cjkCount * 2 + otherCount / 4)
}

/** Sum token estimates across all parts of a message's content array. */
const estimateMessageTokens = (content: MessageContent[]): number => {
  let total = 0
  for (const part of content) {
    switch (part._tag) {
      case 'text':
      case 'thinking':
      case 'steering':
        total += estimateTokens(part.text)
        break
      case 'tool_call':
        total += estimateTokens(JSON.stringify(part.input))
        break
      case 'tool_result':
        total += estimateTokens(JSON.stringify(part.output))
        break
    }
  }
  return total
}

export { estimateMessageTokens, estimateTokens }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/session/token.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session/token.ts src/session/token.test.ts
git commit -m "feat(session): add CJK-aware token estimation"
```

---

### Task 3: Session CRUD

**Files:**
- Create: `src/session/session.ts`
- Create: `src/session/session.test.ts`

- [ ] **Step 1: Write `src/session/session.test.ts`**

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { createSession, deleteSession, getSession, listSessions, touchSession, updateSessionTitle } from './session.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

describe('session CRUD', () => {
  let handle: DB

  beforeEach(async () => {
    handle = await setupDB()
  })

  it('creates a session with generated id and timestamps', async () => {
    const session = await createSession(handle, 'My Chat')
    expect(session.id).toBeTruthy()
    expect(session.title).toBe('My Chat')
    expect(session.parentId).toBeNull()
    expect(session.branchPoint).toBeNull()
    expect(session.metadata).toEqual({})
    expect(session.createdAt).toBeGreaterThan(0)
    expect(session.updatedAt).toBeGreaterThan(0)
  })

  it('retrieves a session by id', async () => {
    const created = await createSession(handle, 'Test')
    const found = await getSession(handle, created.id)
    expect(found).not.toBeNull()
    expect(found?.title).toBe('Test')
  })

  it('returns null for non-existent session', async () => {
    const found = await getSession(handle, '00000000-0000-0000-0000-000000000000')
    expect(found).toBeNull()
  })

  it('lists all sessions', async () => {
    await createSession(handle, 'A')
    await createSession(handle, 'B')
    const list = await listSessions(handle)
    expect(list).toHaveLength(2)
  })

  it('updates a session title', async () => {
    const created = await createSession(handle, 'Old')
    await updateSessionTitle(handle, created.id, 'New')
    const found = await getSession(handle, created.id)
    expect(found?.title).toBe('New')
  })

  it('deletes a session', async () => {
    const created = await createSession(handle, 'Gone')
    await deleteSession(handle, created.id)
    const found = await getSession(handle, created.id)
    expect(found).toBeNull()
  })

  it('touches updatedAt without changing title', async () => {
    const created = await createSession(handle, 'Persist')
    const originalUpdatedAt = created.updatedAt
    await new Promise((r) => setTimeout(r, 10))
    await touchSession(handle, created.id)
    const found = await getSession(handle, created.id)
    expect(found?.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/session/session.test.ts`
Expected: FAIL — `Cannot find module './session.js'`

- [ ] **Step 3: Write `src/session/session.ts`**

```typescript
import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessions } from '../db/schema.js'
import type { Session, SessionMetadata } from '../shared/types/message.js'

/** Convert a DB row (with Date timestamps) to the shared Session type (with number timestamps). */
function rowToSession(row: typeof sessions.$inferSelect): Session {
  const created = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime()
  const updated = row.updatedAt instanceof Date ? row.updatedAt.getTime() : new Date(row.updatedAt).getTime()
  return {
    id: row.id,
    title: row.title,
    parentId: row.parentId,
    branchPoint: row.branchPoint,
    metadata: (row.metadata ?? {}) as SessionMetadata,
    createdAt: created,
    updatedAt: updated,
  }
}

/** Create a new root session. */
async function createSession(handle: DB, title: string): Promise<Session> {
  const [row] = await handle.db.insert(sessions).values({ title }).returning()
  return rowToSession(row!)
}

/** Get a session by id, or null if not found. */
async function getSession(handle: DB, id: string): Promise<Session | null> {
  const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, id))
  return row ? rowToSession(row) : null
}

/** List all sessions. */
async function listSessions(handle: DB): Promise<Session[]> {
  const rows = await handle.db.select().from(sessions)
  return rows.map(rowToSession)
}

/** Delete a session (cascades to entries, archives, snapshots via FK). */
async function deleteSession(handle: DB, id: string): Promise<void> {
  await handle.db.delete(sessions).where(eq(sessions.id, id))
}

/** Update a session's title. */
async function updateSessionTitle(handle: DB, id: string, title: string): Promise<void> {
  await handle.db.update(sessions).set({ title, updatedAt: new Date() }).where(eq(sessions.id, id))
}

/** Bump updatedAt to now (used after appending messages). */
async function touchSession(handle: DB, id: string): Promise<void> {
  await handle.db.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, id))
}

export { createSession, deleteSession, getSession, listSessions, touchSession, updateSessionTitle }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/session/session.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session/session.ts src/session/session.test.ts
git commit -m "feat(session): add session CRUD operations"
```

---

### Task 4: Message Operations

**Files:**
- Create: `src/session/message.ts`
- Create: `src/session/message.test.ts`

- [ ] **Step 1: Write `src/session/message.test.ts`**

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { MessageContent } from '../shared/types/message.js'
import { createSession } from './session.js'
import {
  appendMessage,
  deleteMessagesAfter,
  getEntries,
  getMessageCount,
  getMessages,
} from './message.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('message operations', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    const session = await createSession(handle, 'Test')
    sessionId = session.id
  })

  it('appends a message and returns it with generated id/timestamp', async () => {
    const msg = await appendMessage(handle, sessionId, { role: 'user', content: textContent('Hello') })
    expect(msg.id).toBeTruthy()
    expect(msg.sessionId).toBe(sessionId)
    expect(msg.role).toBe('user')
    expect(msg.content).toEqual(textContent('Hello'))
    expect(msg.tokenCount).toBeGreaterThan(0)
    expect(msg.createdAt).toBeGreaterThan(0)
  })

  it('preserves explicit tokenCount when provided', async () => {
    const msg = await appendMessage(handle, sessionId, {
      role: 'user',
      content: textContent('Hi'),
      tokenCount: 42,
    })
    expect(msg.tokenCount).toBe(42)
  })

  it('stores tool_call and tool_result content parts', async () => {
    const content: MessageContent[] = [
      { _tag: 'tool_call', id: 'call-1', tool: 'read', input: { path: '/a.ts' } },
    ]
    const msg = await appendMessage(handle, sessionId, { role: 'assistant', content })
    expect(msg.content[0]?._tag).toBe('tool_call')
  })

  it('retrieves messages in insertion order', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('first') })
    await appendMessage(handle, sessionId, { role: 'assistant', content: textContent('second') })
    const messages = await getMessages(handle, sessionId)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.content[0]).toMatchObject({ text: 'first' })
    expect(messages[1]?.content[0]).toMatchObject({ text: 'second' })
  })

  it('counts messages', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('a') })
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('b') })
    expect(await getMessageCount(handle, sessionId)).toBe(2)
  })

  it('respects limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await appendMessage(handle, sessionId, { role: 'user', content: textContent(`msg-${i}`) })
    }
    const page = await getMessages(handle, sessionId, { limit: 2, offset: 1 })
    expect(page).toHaveLength(2)
    expect(page[0]?.content[0]).toMatchObject({ text: 'msg-1' })
  })

  it('deletes messages after a given index', async () => {
    for (let i = 0; i < 4; i++) {
      await appendMessage(handle, sessionId, { role: 'user', content: textContent(`msg-${i}`) })
    }
    await deleteMessagesAfter(handle, sessionId, 1) // keep 0,1; delete 2,3
    const remaining = await getMessages(handle, sessionId)
    expect(remaining).toHaveLength(2)
    expect(remaining[1]?.content[0]).toMatchObject({ text: 'msg-1' })
  })

  it('getEntries returns messages and special entries together', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('hi') })
    await appendMessage(handle, sessionId, {
      role: 'system',
      _tag: 'steering' as never,
      content: textContent(''),
    } as never).catch(() => null) // not used here
    const entries = await getEntries(handle, sessionId)
    expect(entries).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/session/message.test.ts`
Expected: FAIL — `Cannot find module './message.js'`

- [ ] **Step 3: Write `src/session/message.ts`**

```typescript
import { and, asc, count, eq, inArray } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessionEntries } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { Message, MessageContent, MessageRole } from '../shared/types/message.js'
import type { MessageInput, SessionEntry } from './types.js'
import { estimateMessageTokens } from './token.js'
import { touchSession } from './session.js'

/** Convert a Date-like DB value to epoch milliseconds. */
function toEpochMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return new Date(value).getTime()
}

/** Convert a message-tagged row to a Message. */
function rowToMessage(row: typeof sessionEntries.$inferSelect): Message {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as MessageRole,
    content: row.content as MessageContent[],
    tokenCount: row.tokenCount ?? 0,
    createdAt: toEpochMs(row.createdAt),
  }
}

/** Convert any row to a SessionEntry (dispatch on tag). */
function rowToEntry(row: typeof sessionEntries.$inferSelect): SessionEntry {
  if (row.tag === 'message') {
    return rowToMessage(row)
  }
  const content = row.content as Record<string, unknown>
  const createdAt = toEpochMs(row.createdAt)
  switch (row.tag) {
    case 'compaction':
      return {
        _tag: 'compaction',
        id: row.id,
        sessionId: row.sessionId,
        summary: content.summary as string,
        originalEntryIds: content.originalEntryIds as string[],
        archiveId: content.archiveId as string,
        tokenCount: row.tokenCount ?? 0,
        createdAt,
      }
    case 'squash':
      return {
        _tag: 'squash',
        id: row.id,
        sessionId: row.sessionId,
        summary: content.summary as string,
        squashedEntryIds: content.squashedEntryIds as string[],
        archiveId: content.archiveId as string,
        tokenCount: row.tokenCount ?? 0,
        createdAt,
      }
    case 'branch_summary':
      return {
        _tag: 'branch_summary',
        id: row.id,
        sessionId: row.sessionId,
        summary: content.summary as string,
        sourceSessionId: content.sourceSessionId as string,
        createdAt,
      }
    case 'steering':
      return {
        _tag: 'steering',
        id: row.id,
        sessionId: row.sessionId,
        content: content.text as string,
        createdAt,
      }
    default:
      // Fallback: treat unknown tags as messages
      return rowToMessage(row)
  }
}

/** Append a message to a session. Returns the stored Message with generated id/timestamp. */
async function appendMessage(handle: DB, sessionId: string, input: MessageInput): Promise<Message> {
  const tokenCount = input.tokenCount ?? estimateMessageTokens(input.content)
  const [row] = await handle.db
    .insert(sessionEntries)
    .values({
      id: generateId(),
      sessionId,
      tag: 'message',
      role: input.role,
      content: input.content,
      tokenCount,
    })
    .returning()
  await touchSession(handle, sessionId)
  return rowToMessage(row!)
}

/** Get messages for a session (tag='message' only), ordered chronologically. */
async function getMessages(
  handle: DB,
  sessionId: string,
  opts?: { limit?: number; offset?: number },
): Promise<Message[]> {
  const rows = await handle.db
    .select()
    .from(sessionEntries)
    .where(and(eq(sessionEntries.sessionId, sessionId), eq(sessionEntries.tag, 'message')))
    .orderBy(asc(sessionEntries.createdAt))
    .limit(opts?.limit ?? 100_000)
    .offset(opts?.offset ?? 0)
  return rows.map(rowToMessage)
}

/** Count messages in a session. */
async function getMessageCount(handle: DB, sessionId: string): Promise<number> {
  const [result] = await handle.db
    .select({ value: count() })
    .from(sessionEntries)
    .where(and(eq(sessionEntries.sessionId, sessionId), eq(sessionEntries.tag, 'message')))
  return result?.value ?? 0
}

/** Delete all messages after the given 0-based index (keeps 0..index inclusive). */
async function deleteMessagesAfter(handle: DB, sessionId: string, messageIndex: number): Promise<void> {
  const messages = await getMessages(handle, sessionId)
  const toDelete = messages.slice(messageIndex + 1)
  if (toDelete.length > 0) {
    await handle.db
      .delete(sessionEntries)
      .where(inArray(sessionEntries.id, toDelete.map((m) => m.id)))
  }
}

/** Low-level: get ALL entries (messages + special) in chronological order. */
async function getEntries(handle: DB, sessionId: string): Promise<SessionEntry[]> {
  const rows = await handle.db
    .select()
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId))
    .orderBy(asc(sessionEntries.createdAt))
  return rows.map(rowToEntry)
}

/** Low-level: delete entries by id. */
async function deleteEntriesByIds(handle: DB, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await handle.db.delete(sessionEntries).where(inArray(sessionEntries.id, ids))
}

/** Low-level: insert a raw entry row (for compaction/squash/branch_summary/steering). */
async function insertEntry(
  handle: DB,
  values: typeof sessionEntries.$inferInsert,
): Promise<typeof sessionEntries.$inferSelect> {
  const [row] = await handle.db.insert(sessionEntries).values(values).returning()
  return row!
}

export { appendMessage, deleteEntriesByIds, deleteMessagesAfter, getEntries, getMessageCount, getMessages, insertEntry }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/session/message.test.ts`
Expected: PASS (8 tests)

If the `getEntries` test with the `.catch(() => null)` hack is flaky, remove that `it` block — it was a placeholder. The real entry-interleaving test is in the integration test (Task 11).

- [ ] **Step 5: Clean up the placeholder test**

Remove the `getEntries returns messages and special entries together` test from `message.test.ts` (it used invalid input). The `getEntries` function is still tested in the integration test (Task 11).

```typescript
// DELETE this entire it block from message.test.ts:
it('getEntries returns messages and special entries together', async () => {
  ...
})
```

- [ ] **Step 6: Run test again to confirm clean**

Run: `pnpm test src/session/message.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 7: Commit**

```bash
git add src/session/message.ts src/session/message.test.ts
git commit -m "feat(session): add message persistence and entry operations"
```

---

### Task 5: Branching

**Files:**
- Create: `src/session/branch.ts`
- Create: `src/session/branch.test.ts`

- [ ] **Step 1: Write `src/session/branch.test.ts`**

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { MessageContent } from '../shared/types/message.js'
import { appendMessage } from './message.js'
import { getBranches, getTree, forkSession } from './branch.js'
import { createSession, getSession } from './session.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('branching', () => {
  let handle: DB

  beforeEach(async () => {
    handle = await setupDB()
  })

  it('forks a session copying messages up to the branch point', async () => {
    const parent = await createSession(handle, 'Parent')
    for (let i = 0; i < 5; i++) {
      await appendMessage(handle, parent.id, { role: 'user', content: textContent(`msg-${i}`) })
    }
    const forked = await forkSession(handle, parent.id, 2)
    expect(forked.parentId).toBe(parent.id)
    expect(forked.branchPoint).toBe(2)
    expect(forked.title).toContain('Parent')
  })

  it('forked session has the copied messages', async () => {
    const parent = await createSession(handle, 'Parent')
    for (let i = 0; i < 4; i++) {
      await appendMessage(handle, parent.id, { role: 'user', content: textContent(`msg-${i}`) })
    }
    const forked = await forkSession(handle, parent.id, 1)
    const { getMessages } = await import('./message.js')
    const forkedMessages = await getMessages(handle, forked.id)
    expect(forkedMessages).toHaveLength(2) // indices 0 and 1
    expect(forkedMessages[1]?.content[0]).toMatchObject({ text: 'msg-1' })
  })

  it('forked session includes a branch_summary entry', async () => {
    const parent = await createSession(handle, 'Parent')
    await appendMessage(handle, parent.id, { role: 'user', content: textContent('hi') })
    const forked = await forkSession(handle, parent.id, 0)
    const { getEntries } = await import('./message.js')
    const entries = await getEntries(handle, forked.id)
    const summary = entries.find((e) => '_tag' in e && e._tag === 'branch_summary')
    expect(summary).toBeDefined()
  })

  it('throws when forking a non-existent session', async () => {
    await expect(forkSession(handle, 'nonexistent', 0)).rejects.toThrow()
  })

  it('getBranches returns child sessions', async () => {
    const parent = await createSession(handle, 'Parent')
    await appendMessage(handle, parent.id, { role: 'user', content: textContent('hi') })
    await forkSession(handle, parent.id, 0)
    await forkSession(handle, parent.id, 0)
    const branches = await getBranches(handle, parent.id)
    expect(branches).toHaveLength(2)
  })

  it('getTree builds a hierarchical tree', async () => {
    const root = await createSession(handle, 'Root')
    await appendMessage(handle, root.id, { role: 'user', content: textContent('hi') })
    const child = await forkSession(handle, root.id, 0)
    await forkSession(handle, child.id, 0) // grandchild
    const tree = await getTree(handle)
    expect(tree).toHaveLength(1) // one root
    expect(tree[0]?.children).toHaveLength(1)
    expect(tree[0]?.children[0]?.children).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/session/branch.test.ts`
Expected: FAIL — `Cannot find module './branch.js'`

- [ ] **Step 3: Write `src/session/branch.ts`**

```typescript
import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { sessions } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { Session, SessionTreeNode } from './types.js'
import { getSession, createSession } from './session.js'
import { getMessages, insertEntry } from './message.js'

/** Fork a session at a message index — copies messages 0..index into a new child session. */
async function forkSession(handle: DB, sessionId: string, messageIndex: number): Promise<Session> {
  const source = await getSession(handle, sessionId)
  if (!source) throw new Error(`Session not found: ${sessionId}`)

  const messages = await getMessages(handle, sessionId)
  const toCopy = messages.slice(0, messageIndex + 1)

  const forked = await createSession(handle, `Branch of ${source.title}`)
  await handle.db
    .update(sessions)
    .set({ parentId: sessionId, branchPoint: messageIndex })
    .where(eq(sessions.id, forked.id))

  for (const msg of toCopy) {
    await insertEntry(handle, {
      id: generateId(),
      sessionId: forked.id,
      tag: 'message',
      role: msg.role,
      content: msg.content,
      tokenCount: msg.tokenCount,
    })
  }

  await insertEntry(handle, {
    id: generateId(),
    sessionId: forked.id,
    tag: 'branch_summary',
    content: {
      summary: `Branched from session ${sessionId} at message ${messageIndex}`,
      sourceSessionId: sessionId,
    },
  })

  const updated = await getSession(handle, forked.id)
  return updated!
}

/** Get direct child sessions (branches) of a session. */
async function getBranches(handle: DB, sessionId: string): Promise<Session[]> {
  const rows = await handle.db.select().from(sessions).where(eq(sessions.parentId, sessionId))
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    parentId: row.parentId,
    branchPoint: row.branchPoint,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime(),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : new Date(row.updatedAt).getTime(),
  }))
}

/** Build a full session tree from root sessions down. */
async function getTree(handle: DB): Promise<SessionTreeNode[]> {
  const rows = await handle.db.select().from(sessions)
  const byParent = new Map<string | null, Session[]>()
  for (const row of rows) {
    const session: Session = {
      id: row.id,
      title: row.title,
      parentId: row.parentId,
      branchPoint: row.branchPoint,
      metadata: row.metadata ?? {},
      createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime(),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : new Date(row.updatedAt).getTime(),
    }
    const list = byParent.get(session.parentId) ?? []
    list.push(session)
    byParent.set(session.parentId, list)
  }

  const build = (parentId: string | null): SessionTreeNode[] =>
    (byParent.get(parentId) ?? []).map((session) => ({
      session,
      children: build(session.id),
    }))

  return build(null)
}

export { forkSession, getBranches, getTree }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/session/branch.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session/branch.ts src/session/branch.test.ts
git commit -m "feat(session): add session branching and tree"
```

---

### Task 6: File Snapshots

**Files:**
- Create: `src/session/snapshot.ts`
- Create: `src/session/snapshot.test.ts`

- [ ] **Step 1: Write `src/session/snapshot.test.ts`**

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import { createSession } from './session.js'
import { checkFileSnapshot, getFileSnapshots, getLatestFileSnapshot, upsertFileSnapshot } from './snapshot.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

describe('file snapshots', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('creates a snapshot and returns its id', async () => {
    const id = await upsertFileSnapshot(handle, sessionId, '/src/a.ts', 'const x = 1')
    expect(id).toBeTruthy()
  })

  it('retrieves the latest snapshot for a file', async () => {
    await upsertFileSnapshot(handle, sessionId, '/src/a.ts', 'v1')
    await upsertFileSnapshot(handle, sessionId, '/src/a.ts', 'v2')
    const latest = await getLatestFileSnapshot(handle, sessionId, '/src/a.ts')
    expect(latest?.content).toBe('v2')
    expect(latest?.version).toBe(2)
  })

  it('lists all snapshots for a session', async () => {
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'a')
    await upsertFileSnapshot(handle, sessionId, '/b.ts', 'b')
    const snapshots = await getFileSnapshots(handle, sessionId)
    expect(snapshots).toHaveLength(2)
  })

  it('checkFileSnapshot returns content when snapshot exists', async () => {
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'cached content')
    const content = await checkFileSnapshot(handle, sessionId, '/a.ts')
    expect(content).toBe('cached content')
  })

  it('checkFileSnapshot returns null when no snapshot', async () => {
    const content = await checkFileSnapshot(handle, sessionId, '/missing.ts')
    expect(content).toBeNull()
  })

  it('computes content hash and token count', async () => {
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'hello world')
    const latest = await getLatestFileSnapshot(handle, sessionId, '/a.ts')
    expect(latest?.contentHash).toHaveLength(64) // sha256 hex
    expect(latest?.tokenCount).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/session/snapshot.test.ts`
Expected: FAIL — `Cannot find module './snapshot.js'`

- [ ] **Step 3: Write `src/session/snapshot.ts`**

```typescript
import { createHash } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { fileSnapshots } from '../db/schema.js'
import type { FileSnapshot } from './types.js'
import { estimateTokens } from './token.js'

function rowToSnapshot(row: typeof fileSnapshots.$inferSelect): FileSnapshot {
  const createdAt = row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime()
  return {
    id: row.id,
    sessionId: row.sessionId,
    filePath: row.filePath,
    content: row.content,
    contentHash: row.contentHash,
    tokenCount: row.tokenCount ?? 0,
    version: row.version ?? 1,
    createdAt,
  }
}

/** Create or update a file snapshot. Always creates a new version. Returns the snapshot id. */
async function upsertFileSnapshot(handle: DB, sessionId: string, filePath: string, content: string): Promise<string> {
  const contentHash = createHash('sha256').update(content).digest('hex')
  const tokenCount = estimateTokens(content)

  const [existing] = await handle.db
    .select()
    .from(fileSnapshots)
    .where(and(eq(fileSnapshots.sessionId, sessionId), eq(fileSnapshots.filePath, filePath)))
    .orderBy(desc(fileSnapshots.version))
    .limit(1)

  const version = (existing?.version ?? 0) + 1
  const [row] = await handle.db
    .insert(fileSnapshots)
    .values({ sessionId, filePath, content, contentHash, tokenCount, version })
    .returning()
  return row!.id
}

/** Get all snapshots for a session. */
async function getFileSnapshots(handle: DB, sessionId: string): Promise<FileSnapshot[]> {
  const rows = await handle.db.select().from(fileSnapshots).where(eq(fileSnapshots.sessionId, sessionId))
  return rows.map(rowToSnapshot)
}

/** Get the latest snapshot for a specific file, or null. */
async function getLatestFileSnapshot(
  handle: DB,
  sessionId: string,
  filePath: string,
): Promise<FileSnapshot | null> {
  const [row] = await handle.db
    .select()
    .from(fileSnapshots)
    .where(and(eq(fileSnapshots.sessionId, sessionId), eq(fileSnapshots.filePath, filePath)))
    .orderBy(desc(fileSnapshots.version))
    .limit(1)
  return row ? rowToSnapshot(row) : null
}

/** Quick check: return cached file content if a snapshot exists, else null. */
async function checkFileSnapshot(handle: DB, sessionId: string, filePath: string): Promise<string | null> {
  const snapshot = await getLatestFileSnapshot(handle, sessionId, filePath)
  return snapshot?.content ?? null
}

export { checkFileSnapshot, getFileSnapshots, getLatestFileSnapshot, upsertFileSnapshot }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/session/snapshot.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session/snapshot.ts src/session/snapshot.test.ts
git commit -m "feat(session): add file snapshot caching"
```

---

### Task 7: Archives

**Files:**
- Create: `src/session/archive.ts`
- Create: `src/session/archive.test.ts`

Uses `ILIKE` substring search (the migration has no GIN/FTS index, so `to_tsvector` would be unindexed and less predictable; ILIKE is simpler and always works in PGLite).

- [ ] **Step 1: Write `src/session/archive.test.ts`**

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { MessageContent } from '../shared/types/message.js'
import { appendMessage } from './message.js'
import { createSession } from './session.js'
import {
  archiveOriginalEntries,
  getArchive,
  getArchiveOriginalEntries,
  parseArchiveReference,
  resolveArchiveReference,
  searchArchives,
} from './archive.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('archives', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('archives entries and returns an archive id', async () => {
    const msg = await appendMessage(handle, sessionId, { role: 'user', content: textContent('hello world') })
    const archiveId = await archiveOriginalEntries(handle, sessionId, [msg], 'compaction', 'Summary text', 'entry-1')
    expect(archiveId).toBeTruthy()
  })

  it('retrieves an archive by id', async () => {
    const msg = await appendMessage(handle, sessionId, { role: 'user', content: textContent('content') })
    const archiveId = await archiveOriginalEntries(handle, sessionId, [msg], 'compaction', 'My summary', 'entry-1')
    const archive = await getArchive(handle, archiveId)
    expect(archive?.summary).toBe('My summary')
    expect(archive?.archiveType).toBe('compaction')
  })

  it('returns null for non-existent archive', async () => {
    const archive = await getArchive(handle, '00000000-0000-0000-0000-000000000000')
    expect(archive).toBeNull()
  })

  it('gets original entries from an archive', async () => {
    const msg = await appendMessage(handle, sessionId, { role: 'user', content: textContent('original') })
    const archiveId = await archiveOriginalEntries(handle, sessionId, [msg], 'compaction', 'summary', 'entry-1')
    const originals = await getArchiveOriginalEntries(handle, archiveId)
    expect(originals).toHaveLength(1)
  })

  it('searches archives by keyword', async () => {
    const msg1 = await appendMessage(handle, sessionId, { role: 'user', content: textContent('alpha beta') })
    const msg2 = await appendMessage(handle, sessionId, { role: 'user', content: textContent('gamma delta') })
    await archiveOriginalEntries(handle, sessionId, [msg1], 'compaction', 'alpha summary', 'e1')
    await archiveOriginalEntries(handle, sessionId, [msg2], 'compaction', 'gamma summary', 'e2')
    const results = await searchArchives(handle, sessionId, 'alpha')
    expect(results).toHaveLength(1)
    expect(results[0]?.summary).toContain('alpha')
  })
})

describe('parseArchiveReference', () => {
  it('parses @[archive:<id>]', () => {
    expect(parseArchiveReference('see @[archive:abc-123]')).toEqual({ type: 'archive', id: 'abc-123' })
  })

  it('parses @[squash:<n>]', () => {
    expect(parseArchiveReference('ref @[squash:2]')).toEqual({ type: 'squash', id: '2' })
  })

  it('parses @[squash:last]', () => {
    expect(parseArchiveReference('ref @[squash:last]')).toEqual({ type: 'squash', id: 'last' })
  })

  it('returns null when no reference found', () => {
    expect(parseArchiveReference('no references here')).toBeNull()
  })
})

describe('resolveArchiveReference', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('resolves an archive reference to summary text', async () => {
    const msg = await appendMessage(handle, sessionId, { role: 'user', content: textContent('data') })
    const archiveId = await archiveOriginalEntries(handle, sessionId, [msg], 'compaction', 'Resolved summary', 'e1')
    const text = await resolveArchiveReference(handle, sessionId, { type: 'archive', id: archiveId })
    expect(text).toContain('Resolved summary')
  })

  it('returns null for missing archive', async () => {
    const text = await resolveArchiveReference(handle, sessionId, { type: 'archive', id: 'missing' })
    expect(text).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/session/archive.test.ts`
Expected: FAIL — `Cannot find module './archive.js'`

- [ ] **Step 3: Write `src/session/archive.ts`**

```typescript
import { and, desc, eq, ilike } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { compactionArchives } from '../db/schema.js'
import { generateId } from '../shared/index.js'
import type { ArchiveRef, CompactionArchive, SessionEntry } from './types.js'

function toEpochMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return new Date(value).getTime()
}

function rowToArchive(row: typeof compactionArchives.$inferSelect): CompactionArchive {
  return {
    id: row.id,
    sessionId: row.sessionId,
    compactionId: row.compactionId,
    archiveType: row.archiveType as 'compaction' | 'squash',
    originalEntries: row.originalEntries as SessionEntry[],
    summary: row.summary,
    tokenCount: row.tokenCount ?? 0,
    searchableText: row.searchableText ?? '',
    createdAt: toEpochMs(row.createdAt),
  }
}

/** Convert an entry to searchable plain text. */
function entryToSearchableText(entry: SessionEntry): string {
  if ('_tag' in entry) {
    return entry.summary ?? entry.content ?? ''
  }
  return entry.content
    .map((part) => {
      switch (part._tag) {
        case 'text':
        case 'thinking':
        case 'steering':
          return part.text
        case 'tool_call':
          return `${part.tool}: ${JSON.stringify(part.input)}`
        case 'tool_result':
          return JSON.stringify(part.output)
      }
    })
    .join(' ')
}

/** Archive original entries before compaction/squash. Returns the archive id. */
async function archiveOriginalEntries(
  handle: DB,
  sessionId: string,
  entries: SessionEntry[],
  archiveType: 'compaction' | 'squash',
  summary: string,
  compactionId: string,
): Promise<string> {
  const id = generateId()
  const searchableText = entries.map(entryToSearchableText).join('\n')
  const tokenCount = entries.reduce((sum, e) => sum + ('tokenCount' in e ? e.tokenCount : 0), 0)
  await handle.db.insert(compactionArchives).values({
    id,
    sessionId,
    compactionId,
    archiveType,
    originalEntries: entries,
    summary,
    tokenCount,
    searchableText,
  })
  return id
}

/** Get an archive by id. */
async function getArchive(handle: DB, id: string): Promise<CompactionArchive | null> {
  const [row] = await handle.db.select().from(compactionArchives).where(eq(compactionArchives.id, id))
  return row ? rowToArchive(row) : null
}

/** Get the original entries stored in an archive. */
async function getArchiveOriginalEntries(handle: DB, archiveId: string): Promise<SessionEntry[]> {
  const archive = await getArchive(handle, archiveId)
  return archive?.originalEntries ?? []
}

/** Search archives by keyword (case-insensitive substring on searchable text). */
async function searchArchives(handle: DB, sessionId: string, query: string): Promise<CompactionArchive[]> {
  const rows = await handle.db
    .select()
    .from(compactionArchives)
    .where(
      and(
        eq(compactionArchives.sessionId, sessionId),
        ilike(compactionArchives.searchableText, `%${query}%`),
      ),
    )
    .orderBy(desc(compactionArchives.createdAt))
  return rows.map(rowToArchive)
}

/** Parse a `@[archive:<id>]` or `@[squash:<n>]` reference from text. Returns null if none. */
function parseArchiveReference(text: string): ArchiveRef | null {
  const archiveMatch = text.match(/@\[archive:([^\]]+)\]/)
  if (archiveMatch) return { type: 'archive', id: archiveMatch[1]! }

  const squashMatch = text.match(/@\[squash:(\d+|last)\]/)
  if (squashMatch) return { type: 'squash', id: squashMatch[1]! }

  return null
}

/** Resolve an archive reference to displayable text. */
async function resolveArchiveReference(
  handle: DB,
  sessionId: string,
  ref: ArchiveRef,
): Promise<string | null> {
  if (ref.type === 'archive') {
    const archive = await getArchive(handle, ref.id)
    return archive ? `[Referenced Archive]\n${archive.summary}` : null
  }

  // squash reference: nth most recent squash archive
  const archives = await handle.db
    .select()
    .from(compactionArchives)
    .where(
      and(
        eq(compactionArchives.sessionId, sessionId),
        eq(compactionArchives.archiveType, 'squash'),
      ),
    )
    .orderBy(desc(compactionArchives.createdAt))

  const index = ref.id === 'last' ? 0 : Number.parseInt(ref.id, 10) - 1
  const row = archives[index]
  if (!row) return null
  return `[Referenced Squash #${index + 1}]\n${row.summary}`
}

export {
  archiveOriginalEntries,
  getArchive,
  getArchiveOriginalEntries,
  parseArchiveReference,
  resolveArchiveReference,
  searchArchives,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/session/archive.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session/archive.ts src/session/archive.test.ts
git commit -m "feat(session): add searchable archives and @ reference resolution"
```

---

### Task 8: Compaction

**Files:**
- Create: `src/session/compaction.ts`
- Create: `src/session/compaction.test.ts`

- [ ] **Step 1: Write `src/session/compaction.test.ts`**

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { MessageContent } from '../shared/types/message.js'
import { appendMessage, getEntries, getMessages } from './message.js'
import { createSession } from './session.js'
import { buildCompactionPrompt, compactSession, extractHotFiles, findSafeCutPoint } from './compaction.js'
import type { Message } from '../shared/types/message.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('findSafeCutPoint', () => {
  const mk = (role: 'user' | 'assistant', text: string): Message => ({
    id: `m-${text}`,
    sessionId: 's',
    role,
    content: textContent(text),
    tokenCount: 1,
    createdAt: 0,
  })

  it('cuts at the start of a user turn at or before the preferred cut', () => {
    const messages = [
      mk('user', 'turn1'),
      mk('assistant', 'reply1'),
      mk('user', 'turn2'),
      mk('assistant', 'reply2'),
      mk('user', 'turn3'),
      mk('assistant', 'reply3'),
    ]
    // preferred cut at index 4 → walk back to find user at index 4 (turn3)
    expect(findSafeCutPoint(messages, 4)).toBe(4)
  })

  it('cuts at the earliest user turn if preferred cut is before any user turn', () => {
    const messages = [mk('assistant', 'a'), mk('user', 'u')]
    expect(findSafeCutPoint(messages, 0)).toBe(1)
  })

  it('returns 0 when no user turn exists at or before cut', () => {
    const messages = [mk('assistant', 'a'), mk('assistant', 'b')]
    expect(findSafeCutPoint(messages, 1)).toBe(0)
  })
})

describe('extractHotFiles', () => {
  it('returns files accessed multiple times', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        sessionId: 's',
        role: 'assistant',
        content: [{ _tag: 'tool_call', id: 'c1', tool: 'read', input: { path: '/a.ts' } }],
        tokenCount: 1,
        createdAt: 0,
      },
      {
        id: 'm2',
        sessionId: 's',
        role: 'tool',
        content: [{ _tag: 'tool_result', id: 'c1', tool: 'read', output: { _tag: 'success', output: 'content-a' } }],
        tokenCount: 1,
        createdAt: 1,
      },
      {
        id: 'm3',
        sessionId: 's',
        role: 'assistant',
        content: [{ _tag: 'tool_call', id: 'c2', tool: 'read', input: { path: '/a.ts' } }],
        tokenCount: 1,
        createdAt: 2,
      },
      {
        id: 'm4',
        sessionId: 's',
        role: 'tool',
        content: [{ _tag: 'tool_result', id: 'c2', tool: 'read', output: { _tag: 'success', output: 'content-a-v2' } }],
        tokenCount: 1,
        createdAt: 3,
      },
    ]
    const hot = extractHotFiles(messages)
    expect(hot).toHaveLength(1)
    expect(hot[0]?.path).toBe('/a.ts')
    expect(hot[0]?.content).toBe('content-a-v2') // latest content
    expect(hot[0]?.accessCount).toBe(2)
  })

  it('ignores files accessed only once', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        sessionId: 's',
        role: 'assistant',
        content: [{ _tag: 'tool_call', id: 'c1', tool: 'read', input: { path: '/once.ts' } }],
        tokenCount: 1,
        createdAt: 0,
      },
    ]
    expect(extractHotFiles(messages)).toHaveLength(0)
  })
})

describe('buildCompactionPrompt', () => {
  it('includes the section headers and entry content', () => {
    const messages: Message[] = [
      { id: 'm1', sessionId: 's', role: 'user', content: textContent('do something'), tokenCount: 1, createdAt: 0 },
      { id: 'm2', sessionId: 's', role: 'assistant', content: textContent('done'), tokenCount: 1, createdAt: 1 },
    ]
    const prompt = buildCompactionPrompt(messages)
    expect(prompt).toContain('## Goal')
    expect(prompt).toContain('## Progress')
    expect(prompt).toContain('do something')
    expect(prompt).toContain('done')
  })
})

describe('compactSession', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('returns compacted:false when too few messages', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('only one') })
    const result = await compactSession(handle, sessionId, async () => 'summary', { keepRecent: 6 })
    expect(result.compacted).toBe(false)
  })

  it('compacts old messages and keeps recent ones', async () => {
    // 6 user/assistant turns = 6 messages
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, { role: i % 2 === 0 ? 'user' : 'assistant', content: textContent(`msg-${i}`) })
    }
    const result = await compactSession(handle, sessionId, async (prompt) => `SUMMARY: ${prompt.slice(0, 20)}`, {
      keepRecent: 2,
    })
    expect(result.compacted).toBe(true)
    if (result.compacted) {
      expect(result.summary).toContain('SUMMARY')
      expect(result.compactedCount).toBeGreaterThan(0)
      expect(result.keptCount).toBe(2)
      expect(result.archiveId).toBeTruthy()
    }
  })

  it('leaves a compaction entry after compacted messages', async () => {
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, { role: i % 2 === 0 ? 'user' : 'assistant', content: textContent(`msg-${i}`) })
    }
    await compactSession(handle, sessionId, async () => 'compacted summary', { keepRecent: 2 })
    const entries = await getEntries(handle, sessionId)
    const compaction = entries.find((e) => '_tag' in e && e._tag === 'compaction')
    expect(compaction).toBeDefined()
  })

  it('removes compacted messages from the session', async () => {
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, { role: i % 2 === 0 ? 'user' : 'assistant', content: textContent(`msg-${i}`) })
    }
    await compactSession(handle, sessionId, async () => 'summary', { keepRecent: 2 })
    const remaining = await getMessages(handle, sessionId)
    expect(remaining).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/session/compaction.test.ts`
Expected: FAIL — `Cannot find module './compaction.js'`

- [ ] **Step 3: Write `src/session/compaction.ts`**

```typescript
import { generateId } from '../shared/index.js'
import type { DB } from '../db/client.js'
import type { Message } from '../shared/types/message.js'
import type { CompactionConfig, CompactionResult, HotFile, SessionEntry, Summarizer } from './types.js'
import { archiveOriginalEntries } from './archive.js'
import { deleteEntriesByIds, getMessages, insertEntry } from './message.js'
import { estimateTokens } from './token.js'
import { upsertFileSnapshot } from './snapshot.js'

/**
 * Find a safe cut point: the index of the most recent 'user' message
 * at or before `preferredCut`. Cutting at a user-turn boundary ensures
 * we never split an assistant reply from its tool results.
 */
function findSafeCutPoint(messages: Message[], preferredCut: number): number {
  const upper = Math.min(preferredCut, messages.length)
  for (let i = upper; i >= 0; i--) {
    const msg = messages[i]
    if (msg && msg.role === 'user') return i
  }
  return 0
}

/** Extract frequently-accessed files (read ≥ 2 times) from message history. */
function extractHotFiles(messages: Message[]): HotFile[] {
  const accessCount = new Map<string, number>()
  const latestContent = new Map<string, string>()

  // First pass: collect tool_call paths and access counts
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part._tag === 'tool_call' && part.tool === 'read') {
        const input = part.input as { path?: string }
        if (input?.path) {
          accessCount.set(input.path, (accessCount.get(input.path) ?? 0) + 1)
        }
      }
    }
  }

  // Second pass: collect latest read results
  const callPath = new Map<string, string>() // callId → path
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part._tag === 'tool_call' && part.tool === 'read') {
        const input = part.input as { path?: string }
        if (input?.path) callPath.set(part.id, input.path)
      }
      if (part._tag === 'tool_result' && part.tool === 'read') {
        if (part.output._tag === 'success') {
          const path = callPath.get(part.id)
          if (path) latestContent.set(path, part.output.output)
        }
      }
    }
  }

  const hot: HotFile[] = []
  for (const [path, count] of accessCount) {
    if (count >= 2) {
      const content = latestContent.get(path)
      if (content) {
        hot.push({ path, content, tokenCount: estimateTokens(content), accessCount: count })
      }
    }
  }
  return hot.sort((a, b) => b.accessCount - a.accessCount).slice(0, 10)
}

/** Build the LLM summarization prompt for a set of messages. */
function buildCompactionPrompt(messages: Message[]): string {
  const history = messages
    .map((m) => `[${m.role}] ${m.content.map((p) => (p._tag === 'text' ? p.text : JSON.stringify(p))).join(' ')}`)
    .join('\n')

  return `将以下对话历史压缩为结构化摘要。保留关键信息，丢弃冗余细节。

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
${history}`
}

/**
 * Compact a session: summarize old messages, archive them, keep recent ones.
 * The `summarizer` function is injected (the session layer never imports the LLM package).
 */
async function compactSession(
  handle: DB,
  sessionId: string,
  summarizer: Summarizer,
  config?: Partial<CompactionConfig>,
): Promise<CompactionResult> {
  const messages = await getMessages(handle, sessionId)
  const keepRecent = config?.keepRecent ?? 6

  if (messages.length <= keepRecent) {
    return { compacted: false, reason: 'too_few_messages' }
  }

  const preferredCut = messages.length - keepRecent
  const cutPoint = findSafeCutPoint(messages, preferredCut)
  const compactMessages = messages.slice(0, cutPoint)
  const keepMessages = messages.slice(cutPoint)

  if (compactMessages.length === 0) {
    return { compacted: false, reason: 'nothing_to_compact' }
  }

  const prompt = buildCompactionPrompt(compactMessages)
  const summary = await summarizer(prompt)

  // Pre-generate the compaction entry id so the archive can reference it
  const compactionEntryId = generateId()
  const archiveId = await archiveOriginalEntries(
    handle,
    sessionId,
    compactMessages,
    'compaction',
    summary,
    compactionEntryId,
  )

  // Persist hot file snapshots
  const fileSnapshotIds: string[] = []
  if (config?.preserveSnapshots !== false) {
    const hotFiles = extractHotFiles(compactMessages)
    for (const file of hotFiles) {
      const id = await upsertFileSnapshot(handle, sessionId, file.path, file.content)
      fileSnapshotIds.push(id)
    }
  }

  // Delete compacted message rows
  await deleteEntriesByIds(handle, compactMessages.map((m) => m.id))

  // Insert the compaction summary entry at the cut position
  await insertEntry(handle, {
    id: compactionEntryId,
    sessionId,
    tag: 'compaction',
    content: {
      summary,
      originalEntryIds: compactMessages.map((m) => m.id),
      archiveId,
    },
    tokenCount: estimateTokens(summary),
  })

  return {
    compacted: true,
    summary,
    archiveId,
    fileSnapshots: fileSnapshotIds,
    compactedCount: compactMessages.length,
    keptCount: keepMessages.length,
  }
}

export { buildCompactionPrompt, compactSession, extractHotFiles, findSafeCutPoint }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/session/compaction.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session/compaction.ts src/session/compaction.test.ts
git commit -m "feat(session): add compaction with injected summarizer and hot-file extraction"
```

---

### Task 9: Squash

**Files:**
- Create: `src/session/squash.ts`
- Create: `src/session/squash.test.ts`

- [ ] **Step 1: Write `src/session/squash.test.ts`**

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { MessageContent } from '../shared/types/message.js'
import { appendMessage, getEntries, getMessages } from './message.js'
import { createSession } from './session.js'
import { squashRecent } from './squash.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('squashRecent', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('returns compacted:false when too few messages', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('one') })
    const result = await squashRecent(handle, sessionId, 3, async () => 'squash summary', {
      keepRecent: 2,
      preserveFileSnapshots: false,
      archiveOriginal: true,
    })
    expect(result.compacted).toBe(false)
  })

  it('squashes recent interactions into a summary entry', async () => {
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`msg-${i}`),
      })
    }
    const result = await squashRecent(handle, sessionId, 4, async () => 'squashed!', {
      keepRecent: 2,
      preserveFileSnapshots: false,
      archiveOriginal: true,
    })
    expect(result.compacted).toBe(true)
    if (result.compacted) {
      expect(result.summary).toBe('squashed!')
      expect(result.archiveId).toBeTruthy()
    }
  })

  it('leaves a squash entry in the session', async () => {
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`msg-${i}`),
      })
    }
    await squashRecent(handle, sessionId, 4, async () => 'summary', {
      keepRecent: 2,
      preserveFileSnapshots: false,
      archiveOriginal: true,
    })
    const entries = await getEntries(handle, sessionId)
    const squash = entries.find((e) => '_tag' in e && e._tag === 'squash')
    expect(squash).toBeDefined()
  })

  it('keeps the specified number of recent messages after the squash entry', async () => {
    for (let i = 0; i < 6; i++) {
      await appendMessage(handle, sessionId, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`msg-${i}`),
      })
    }
    await squashRecent(handle, sessionId, 4, async () => 'summary', {
      keepRecent: 2,
      preserveFileSnapshots: false,
      archiveOriginal: true,
    })
    const remaining = await getMessages(handle, sessionId)
    expect(remaining).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/session/squash.test.ts`
Expected: FAIL — `Cannot find module './squash.js'`

- [ ] **Step 3: Write `src/session/squash.ts`**

```typescript
import { generateId } from '../shared/index.js'
import type { DB } from '../db/client.js'
import type { CompactionResult, SquashConfig, Summarizer } from './types.js'
import { archiveOriginalEntries } from './archive.js'
import { deleteEntriesByIds, getMessages, insertEntry } from './message.js'
import { estimateTokens } from './token.js'
import { upsertFileSnapshot } from './snapshot.js'
import { extractHotFiles } from './compaction.js'

/** Default squash configuration. */
const DEFAULT_SQUASH_CONFIG: SquashConfig = {
  keepRecent: 2,
  preserveFileSnapshots: true,
  archiveOriginal: true,
}

/**
 * Squash the most recent `count` messages into a summary, keeping `keepRecent` of them verbatim.
 * Similar to `git rebase -i + squash`: compresses recent interactions while preserving the
 * conversation prefix and a small tail for cache stability.
 */
async function squashRecent(
  handle: DB,
  sessionId: string,
  count: number,
  summarizer: Summarizer,
  config?: Partial<SquashConfig>,
): Promise<CompactionResult> {
  const cfg = { ...DEFAULT_SQUASH_CONFIG, ...config }
  const messages = await getMessages(handle, sessionId)

  if (messages.length < count + cfg.keepRecent) {
    return { compacted: false, reason: 'too_few_messages' }
  }

  // The messages to squash: the last `count` minus the ones we keep verbatim
  const tailStart = messages.length - cfg.keepRecent
  const squashStart = messages.length - count
  const toSquash = messages.slice(squashStart, tailStart)
  const keepTail = messages.slice(tailStart)

  if (toSquash.length === 0) {
    return { compacted: false, reason: 'nothing_to_compact' }
  }

  // Build squash prompt
  const history = toSquash
    .map((m) => `[${m.role}] ${m.content.map((p) => (p._tag === 'text' ? p.text : JSON.stringify(p))).join(' ')}`)
    .join('\n')

  const prompt = `将以下最近的交互压缩为简洁摘要，保留关键决策和上下文，丢弃冗余细节。
重点保留：修改了哪些文件、做了什么决策、当前进度、下一步计划。

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
${history}`

  const summary = await summarizer(prompt)

  // Pre-generate the squash entry id
  const squashEntryId = generateId()
  const archiveId = cfg.archiveOriginal
    ? await archiveOriginalEntries(handle, sessionId, toSquash, 'squash', summary, squashEntryId)
    : generateId()

  // Persist hot file snapshots
  const fileSnapshotIds: string[] = []
  if (cfg.preserveFileSnapshots) {
    const hotFiles = extractHotFiles(toSquash)
    for (const file of hotFiles) {
      const id = await upsertFileSnapshot(handle, sessionId, file.path, file.content)
      fileSnapshotIds.push(id)
    }
  }

  // Delete squashed messages
  await deleteEntriesByIds(handle, toSquash.map((m) => m.id))

  // Insert squash summary entry
  await insertEntry(handle, {
    id: squashEntryId,
    sessionId,
    tag: 'squash',
    content: {
      summary,
      squashedEntryIds: toSquash.map((m) => m.id),
      archiveId,
    },
    tokenCount: estimateTokens(summary),
  })

  return {
    compacted: true,
    summary,
    archiveId,
    fileSnapshots: fileSnapshotIds,
    compactedCount: toSquash.length,
    keptCount: keepTail.length,
  }
}

export { squashRecent }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/session/squash.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session/squash.ts src/session/squash.test.ts
git commit -m "feat(session): add squash compression for recent interactions"
```

---

### Task 10: Context Reconstruction

**Files:**
- Create: `src/session/context.ts`
- Create: `src/session/context.test.ts`

- [ ] **Step 1: Write `src/session/context.test.ts`**

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { ChatMessage } from '../shared/types/llm.js'
import type { MessageContent } from '../shared/types/message.js'
import { appendMessage, insertEntry } from './message.js'
import { createSession } from './session.js'
import { upsertFileSnapshot } from './snapshot.js'
import { entriesToChatMessages, getSessionContext, injectSnapshots, messageToChatMessage } from './context.js'
import type { Message } from '../shared/types/message.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('messageToChatMessage', () => {
  it('converts a text message to a ChatMessage', () => {
    const msg: Message = {
      id: 'm1',
      sessionId: 's',
      role: 'user',
      content: textContent('hello'),
      tokenCount: 1,
      createdAt: 0,
    }
    const chat = messageToChatMessage(msg)
    expect(chat.role).toBe('user')
    expect(typeof chat.content).toBe('string')
    expect(chat.content).toContain('hello')
  })

  it('includes tool_calls in assistant messages', () => {
    const msg: Message = {
      id: 'm1',
      sessionId: 's',
      role: 'assistant',
      content: [
        { _tag: 'text', text: 'let me read' },
        { _tag: 'tool_call', id: 'c1', tool: 'read', input: { path: '/a.ts' } },
      ],
      tokenCount: 1,
      createdAt: 0,
    }
    const chat = messageToChatMessage(msg)
    expect(chat.toolCalls).toBeDefined()
    expect(chat.toolCalls).toHaveLength(1)
    expect(chat.toolCalls?.[0]?.name).toBe('read')
  })

  it('maps tool_result messages with toolCallId', () => {
    const msg: Message = {
      id: 'm1',
      sessionId: 's',
      role: 'tool',
      content: [{ _tag: 'tool_result', id: 'c1', tool: 'read', output: { _tag: 'success', output: 'data' } }],
      tokenCount: 1,
      createdAt: 0,
    }
    const chat = messageToChatMessage(msg)
    expect(chat.role).toBe('tool')
    expect(chat.toolCallId).toBe('c1')
  })
})

describe('entriesToChatMessages', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('converts messages and special entries to ChatMessage[]', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('question') })
    await insertEntry(handle, {
      sessionId,
      tag: 'steering',
      content: { text: 'Be concise' },
    })
    await appendMessage(handle, sessionId, { role: 'assistant', content: textContent('answer') })

    const { entries } = await getSessionContext(handle, sessionId)
    const messages = entriesToChatMessages(entries, [])
    expect(messages).toHaveLength(3)
    expect(messages[1]?.role).toBe('system')
    expect(messages[1]?.content).toContain('Be concise')
  })

  it('renders compaction entries as system messages', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('old') })
    await insertEntry(handle, {
      sessionId,
      tag: 'compaction',
      content: { summary: 'past summary', originalEntryIds: [], archiveId: 'a1' },
      tokenCount: 5,
    })
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('new') })

    const { entries } = await getSessionContext(handle, sessionId)
    const messages = entriesToChatMessages(entries, [])
    const systemMsg = messages.find((m) => m.role === 'system' && m.content.includes('past summary'))
    expect(systemMsg).toBeDefined()
  })
})

describe('injectSnapshots', () => {
  it('injects file snapshot block after the first message', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hi' },
    ]
    const snapshots = [{ filePath: '/a.ts', content: 'const x = 1' }]
    const result = injectSnapshots(messages, snapshots)
    expect(result).toHaveLength(3)
    expect(result[0]?.content).toBe('system prompt')
    expect(result[1]?.role).toBe('system')
    expect(result[1]?.content).toContain('/a.ts')
    expect(result[1]?.content).toContain('const x = 1')
  })

  it('returns messages unchanged when no snapshots', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
    expect(injectSnapshots(messages, [])).toBe(messages)
  })
})

describe('getSessionContext', () => {
  let handle: DB
  let sessionId: string

  beforeEach(async () => {
    handle = await setupDB()
    sessionId = (await createSession(handle, 'Test')).id
  })

  it('returns entries and snapshots', async () => {
    await appendMessage(handle, sessionId, { role: 'user', content: textContent('hi') })
    await upsertFileSnapshot(handle, sessionId, '/a.ts', 'content')
    const { entries, snapshots } = await getSessionContext(handle, sessionId)
    expect(entries.length).toBeGreaterThan(0)
    expect(snapshots).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/session/context.test.ts`
Expected: FAIL — `Cannot find module './context.js'`

- [ ] **Step 3: Write `src/session/context.ts`**

```typescript
import type { DB } from '../db/client.js'
import type { ChatMessage } from '../shared/types/llm.js'
import type { Message } from '../shared/types/message.js'
import type { FileSnapshot, SessionEntry } from './types.js'
import { getEntries } from './message.js'
import { getFileSnapshots } from './snapshot.js'

/** Convert a stored Message to a protocol-level ChatMessage for the LLM. */
function messageToChatMessage(msg: Message): ChatMessage {
  const textParts = msg.content
    .filter((p) => p._tag === 'text' || p._tag === 'thinking')
    .map((p) => (p._tag === 'thinking' ? `<think>${p.text}</think>` : p.text))
    .join('')

  const toolCalls = msg.content
    .filter((p) => p._tag === 'tool_call')
    .map((p) => ({
      id: p.id,
      name: p.tool,
      arguments: JSON.stringify(p.input),
    }))

  const toolResultPart = msg.content.find((p) => p._tag === 'tool_result')

  const chat: ChatMessage = {
    role: msg.role,
    content: textParts || (toolResultPart ? JSON.stringify(toolResultPart.output) : ''),
  }

  if (toolCalls.length > 0) {
    chat.toolCalls = toolCalls
  }

  if (toolResultPart && toolResultPart._tag === 'tool_result') {
    chat.toolCallId = toolResultPart.id
    chat.content = JSON.stringify(toolResultPart.output)
  }

  return chat
}

/** Convert all session entries (messages + special) to ChatMessage[] for the LLM. */
function entriesToChatMessages(entries: SessionEntry[], snapshots: FileSnapshot[]): ChatMessage[] {
  const messages: ChatMessage[] = []

  for (const entry of entries) {
    if (!('_tag' in entry)) {
      // Regular message
      messages.push(messageToChatMessage(entry))
      continue
    }

    switch (entry._tag) {
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
    }
  }

  return injectSnapshots(messages, snapshots)
}

/** Inject file snapshot block after the first message (preserves cache prefix). */
function injectSnapshots(
  messages: ChatMessage[],
  snapshots: FileSnapshot[],
): ChatMessage[] {
  if (snapshots.length === 0) return messages

  const block = snapshots
    .map((s) => `[Cached File: ${s.filePath}]\n\`\`\`\n${s.content}\n\`\`\``)
    .join('\n\n')

  const snapshotMessage: ChatMessage = {
    role: 'system',
    content: `[Active File Snapshots — DO NOT re-read these files]\n${block}`,
  }

  if (messages.length === 0) return [snapshotMessage]
  return [messages[0]!, snapshotMessage, ...messages.slice(1)]
}

/** Get the full session context: all entries + file snapshots. */
async function getSessionContext(
  handle: DB,
  sessionId: string,
): Promise<{ entries: SessionEntry[]; snapshots: FileSnapshot[] }> {
  const [entries, snapshots] = await Promise.all([
    getEntries(handle, sessionId),
    getFileSnapshots(handle, sessionId),
  ])
  return { entries, snapshots }
}

export { entriesToChatMessages, getSessionContext, injectSnapshots, messageToChatMessage }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/session/context.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/session/context.ts src/session/context.test.ts
git commit -m "feat(session): add context reconstruction and ChatMessage conversion"
```

---

### Task 11: Barrel Export + Integration test

**Files:**
- Create: `src/session/index.ts`
- Create: `src/session/integration.test.ts`

- [ ] **Step 1: Write `src/session/index.ts`**

```typescript
// Session layer: conversation persistence, branching, compaction, and context reconstruction.

export type {
  ArchiveRef,
  BranchSummaryEntry,
  CompactionArchive,
  CompactionConfig,
  CompactionEntry,
  CompactionResult,
  FileSnapshot,
  HotFile,
  MessageInput,
  SessionEntry,
  SessionTreeNode,
  SquashConfig,
  SquashEntry,
  SteeringEntry,
  Summarizer,
} from './types.js'

export { estimateMessageTokens, estimateTokens } from './token.js'

export { createSession, deleteSession, getSession, listSessions, touchSession, updateSessionTitle } from './session.js'

export {
  appendMessage,
  deleteEntriesByIds,
  deleteMessagesAfter,
  getEntries,
  getMessageCount,
  getMessages,
  insertEntry,
} from './message.js'

export { forkSession, getBranches, getTree } from './branch.js'

export { checkFileSnapshot, getFileSnapshots, getLatestFileSnapshot, upsertFileSnapshot } from './snapshot.js'

export {
  archiveOriginalEntries,
  getArchive,
  getArchiveOriginalEntries,
  parseArchiveReference,
  resolveArchiveReference,
  searchArchives,
} from './archive.js'

export { buildCompactionPrompt, compactSession, extractHotFiles, findSafeCutPoint } from './compaction.js'

export { squashRecent } from './squash.js'

export { entriesToChatMessages, getSessionContext, injectSnapshots, messageToChatMessage } from './context.js'
```

- [ ] **Step 2: Write `src/session/integration.test.ts`**

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { MessageContent } from '../shared/types/message.js'
import {
  appendMessage,
  compactSession,
  createSession,
  entriesToChatMessages,
  forkSession,
  getEntries,
  getMessages,
  getSessionContext,
  searchArchives,
  squashRecent,
} from './index.js'

async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

const textContent = (text: string): MessageContent[] => [{ _tag: 'text', text }]

describe('session integration', () => {
  let handle: DB

  beforeEach(async () => {
    handle = await setupDB()
  })

  it('full lifecycle: create → chat → compact → branch → squash', async () => {
    // 1. Create session
    const session = await createSession(handle, 'Integration Test')

    // 2. Add a conversation
    for (let i = 0; i < 8; i++) {
      await appendMessage(handle, session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`message number ${i}`),
      })
    }
    expect(await getMessages(handle, session.id)).toHaveLength(8)

    // 3. Compact old messages
    const compactResult = await compactSession(handle, session.id, async (p) => `SUMMARY(${p.length})`, {
      keepRecent: 4,
    })
    expect(compactResult.compacted).toBe(true)

    // 4. Verify compaction entry exists
    const entries = await getEntries(handle, session.id)
    const hasCompaction = entries.some((e) => '_tag' in e && e._tag === 'compaction')
    expect(hasCompaction).toBe(true)

    // 5. Verify archive is searchable
    if (compactResult.compacted) {
      const results = await searchArchives(handle, session.id, 'message')
      expect(results.length).toBeGreaterThan(0)
    }

    // 6. Continue conversation after compaction
    await appendMessage(handle, session.id, { role: 'user', content: textContent('after compaction') })

    // 7. Fork the session
    const forked = await forkSession(handle, session.id, 0)
    expect(forked.parentId).toBe(session.id)

    // 8. Build context for LLM
    const { entries: ctxEntries, snapshots } = await getSessionContext(handle, session.id)
    const chatMessages = entriesToChatMessages(ctxEntries, snapshots)
    expect(chatMessages.length).toBeGreaterThan(0)
    // Should include the compaction summary as a system message
    const hasCompactionMsg = chatMessages.some(
      (m) => m.role === 'system' && m.content.includes('Compacted History'),
    )
    expect(hasCompactionMsg).toBe(true)
  })

  it('squash then reconstruct context', async () => {
    const session = await createSession(handle, 'Squash Test')
    for (let i = 0; i < 8; i++) {
      await appendMessage(handle, session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: textContent(`turn ${i}`),
      })
    }

    const result = await squashRecent(handle, session.id, 4, async () => 'squashed turn', {
      keepRecent: 2,
      preserveFileSnapshots: false,
      archiveOriginal: true,
    })
    expect(result.compacted).toBe(true)

    const { entries } = await getSessionContext(handle, session.id)
    const hasSquash = entries.some((e) => '_tag' in e && e._tag === 'squash')
    expect(hasSquash).toBe(true)

    // Remaining messages should be exactly keepRecent
    expect(await getMessages(handle, session.id)).toHaveLength(2)
  })

  it('handles concurrent sessions independently', async () => {
    const s1 = await createSession(handle, 'Session 1')
    const s2 = await createSession(handle, 'Session 2')

    await appendMessage(handle, s1.id, { role: 'user', content: textContent('in s1') })
    await appendMessage(handle, s2.id, { role: 'user', content: textContent('in s2') })

    expect(await getMessages(handle, s1.id)).toHaveLength(1)
    expect(await getMessages(handle, s2.id)).toHaveLength(1)
    expect((await getMessages(handle, s1.id))[0]?.content[0]).toMatchObject({ text: 'in s1' })
  })
})
```

- [ ] **Step 3: Run the integration test**

Run: `pnpm test src/session/integration.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: Run the full session test suite**

Run: `pnpm test src/session/`
Expected: All tests PASS

- [ ] **Step 5: Typecheck the whole project**

Run: `pnpm typecheck`
Expected: PASS (no errors)

- [ ] **Step 6: Lint**

Run: `pnpm biome check --write src/session/`
Expected: No errors (auto-fixes formatting)

- [ ] **Step 7: Run full test suite to confirm no regressions**

Run: `pnpm test`
Expected: All tests PASS (existing 208 + new session tests)

- [ ] **Step 8: Commit**

```bash
git add src/session/index.ts src/session/integration.test.ts
git commit -m "feat(session): add barrel export and integration tests"
```

---

## Self-Review Notes

**Spec coverage (module spec `session-compaction.md`):**
- §2.2 SessionEntry types → Task 1 (types.ts) ✓
- §2.3 Storage → Tasks 3-4 (uses existing DB schema from Plan 2) ✓
- §2.4 Squash → Task 9 ✓
- §2.5 File snapshots → Task 6 + extractHotFiles in Task 8 ✓
- §2.6 Archive search + @ references → Task 7 ✓
- §2.7 Compaction interface → Task 8 (compactSession with injected Summarizer) ✓
- §2.8 LLM summary strategy → Task 8 (buildCompactionPrompt + injected summarizer) ✓
- §2.9 Safe cut point → Task 8 (findSafeCutPoint) ✓
- §2.10 Branch management → Task 5 ✓
- §2.11 Token estimation → Task 2 ✓
- §2.12 Context reconstruction → Task 10 ✓

**Main spec §8.2 coverage:**
- createSession/getSession/listSessions/deleteSession/updateSessionTitle → Task 3 ✓
- appendMessage/getMessages/getMessageCount/deleteMessagesAfter → Task 4 ✓
- forkSession/getBranches/getTree → Task 5 ✓

**Design decisions:**
- `Summarizer` is injected — Plan 4 depends only on `db` + `shared`, not `llm`. Plan 6 wires the real LLM.
- One row per `Message` (content[] as JSONB) — matches shared `Message` type; special entries are separate rows.
- ILIKE search instead of `to_tsvector` — the migration has no GIN/FTS index; ILIKE is simpler and always works in PGLite.
- CJK-aware `estimateTokens` — separate from LLM layer's `chars/4` heuristic; better for Chinese content.
