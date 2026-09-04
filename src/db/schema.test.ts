import { describe, expect, it } from 'vitest'
import type {
  CompactionArchiveRow,
  FileSnapshotRow,
  SessionEntryRow,
  SessionInsert,
  SessionRow,
} from './schema.js'
import { compactionArchives, fileSnapshots, sessionEntries, sessions } from './schema.js'

describe('sessions table', () => {
  it('has correct table name', () => {
    expect((sessions as unknown as Record<symbol, string>)[Symbol.for('drizzle:Name')]).toBe(
      'sessions',
    )
  })

  it('defines all expected columns', () => {
    const columns = Object.keys(sessions)
    expect(columns).toContain('id')
    expect(columns).toContain('title')
    expect(columns).toContain('parentId')
    expect(columns).toContain('projectId')
    expect(columns).toContain('branchPoint')
    expect(columns).toContain('metadata')
    expect(columns).toContain('createdAt')
    expect(columns).toContain('updatedAt')
  })
})

describe('sessionEntries table', () => {
  it('has correct table name', () => {
    expect((sessionEntries as unknown as Record<symbol, string>)[Symbol.for('drizzle:Name')]).toBe(
      'session_entries',
    )
  })

  it('defines all expected columns', () => {
    const columns = Object.keys(sessionEntries)
    expect(columns).toContain('id')
    expect(columns).toContain('sessionId')
    expect(columns).toContain('tag')
    expect(columns).toContain('role')
    expect(columns).toContain('content')
    expect(columns).toContain('toolName')
    expect(columns).toContain('tokenCount')
    expect(columns).toContain('createdAt')
  })
})

describe('compactionArchives table', () => {
  it('has correct table name', () => {
    expect(
      (compactionArchives as unknown as Record<symbol, string>)[Symbol.for('drizzle:Name')],
    ).toBe('compaction_archives')
  })

  it('defines all expected columns', () => {
    const columns = Object.keys(compactionArchives)
    expect(columns).toContain('id')
    expect(columns).toContain('sessionId')
    expect(columns).toContain('compactionId')
    expect(columns).toContain('archiveType')
    expect(columns).toContain('originalEntries')
    expect(columns).toContain('fileSnapshots')
    expect(columns).toContain('summary')
    expect(columns).toContain('tokenCount')
    expect(columns).toContain('searchableText')
    expect(columns).toContain('createdAt')
  })
})

describe('fileSnapshots table', () => {
  it('has correct table name', () => {
    expect((fileSnapshots as unknown as Record<symbol, string>)[Symbol.for('drizzle:Name')]).toBe(
      'file_snapshots',
    )
  })

  it('defines all expected columns', () => {
    const columns = Object.keys(fileSnapshots)
    expect(columns).toContain('id')
    expect(columns).toContain('sessionId')
    expect(columns).toContain('entryId')
    expect(columns).toContain('filePath')
    expect(columns).toContain('content')
    expect(columns).toContain('contentHash')
    expect(columns).toContain('tokenCount')
    expect(columns).toContain('version')
    expect(columns).toContain('createdAt')
  })
})

describe('type inference', () => {
  it('SessionRow has correct shape', () => {
    const _row: SessionRow = {
      id: '00000000-0000-4000-8000-000000000000',
      title: 'Test',
      parentId: null,
      projectId: null,
      branchPoint: null,
      metadata: {},
      agentType: null,
      worktreePath: null,
      source: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    expect(_row.title).toBe('Test')
  })

  it('SessionInsert allows partial (defaults fill in)', () => {
    const _insert: SessionInsert = {
      title: 'New Session',
    }
    expect(_insert.title).toBe('New Session')
  })

  it('SessionEntryRow has correct shape', () => {
    const _row: SessionEntryRow = {
      id: '00000000-0000-4000-8000-000000000000',
      sessionId: '00000000-0000-4000-8000-000000000001',
      tag: 'message',
      role: 'user',
      content: { text: 'hello' },
      toolName: null,
      tokenCount: 5,
      createdAt: new Date(),
    }
    expect(_row.tag).toBe('message')
  })

  it('CompactionArchiveRow has correct shape', () => {
    const _row: CompactionArchiveRow = {
      id: '00000000-0000-4000-8000-000000000000',
      sessionId: '00000000-0000-4000-8000-000000000001',
      compactionId: '00000000-0000-4000-8000-000000000002',
      archiveType: 'compaction',
      originalEntries: [],
      fileSnapshots: [],
      summary: 'Summary text',
      tokenCount: 100,
      searchableText: 'searchable content',
      createdAt: new Date(),
    }
    expect(_row.archiveType).toBe('compaction')
  })

  it('FileSnapshotRow has correct shape', () => {
    const _row: FileSnapshotRow = {
      id: '00000000-0000-4000-8000-000000000000',
      sessionId: '00000000-0000-4000-8000-000000000001',
      entryId: null,
      filePath: 'src/main.ts',
      content: 'export {}',
      contentHash: 'abc123',
      tokenCount: 2,
      version: 1,
      mtimeMs: null,
      createdAt: new Date(),
    }
    expect(_row.filePath).toBe('src/main.ts')
  })
})

describe('sessions agent columns', () => {
  it('sessions 表含 agentType 和 worktreePath 列', () => {
    // sessions 是 drizzle table 对象，列名通过 Object.keys 访问
    expect(sessions.agentType).toBeDefined()
    expect(sessions.worktreePath).toBeDefined()
  })
})
