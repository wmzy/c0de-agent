import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { desc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fromDirectory, getProject, listProjects, updateProjectName } from '../project/project.js'
import type { DB } from './client.js'
import { createDB } from './client.js'
import { migrateDB } from './migrate.js'
import { compactionArchives, fileSnapshots, projects, sessionEntries, sessions } from './schema.js'

// Each test gets a fresh in-memory database
async function setupDB(): Promise<DB> {
  const handle = await createDB({ driver: 'pglite' })
  await migrateDB(handle)
  return handle
}

describe('DB integration: sessions CRUD', () => {
  let handle: DB

  beforeEach(async () => {
    handle = await setupDB()
  })

  afterEach(async () => {
    await handle.close()
  })

  it('inserts and queries a session', async () => {
    const [inserted] = await handle.db
      .insert(sessions)
      .values({ title: 'Test Session' })
      .returning()

    expect(inserted).toBeDefined()
    expect(inserted?.title).toBe('Test Session')
    expect(inserted?.id).toBeTruthy()
    expect(inserted?.parentId).toBeNull()
    expect(inserted?.metadata).toEqual({})
    expect(inserted?.createdAt).toBeInstanceOf(Date)

    const [retrieved] = await handle.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, inserted?.id ?? ''))

    expect(retrieved?.title).toBe('Test Session')
  })

  it('inserts a child session with parentId', async () => {
    const [parent] = await handle.db.insert(sessions).values({ title: 'Parent' }).returning()

    const [child] = await handle.db
      .insert(sessions)
      .values({ title: 'Child', parentId: parent?.id, branchPoint: 5 })
      .returning()

    expect(child?.parentId).toBe(parent?.id)
    expect(child?.branchPoint).toBe(5)
  })

  it('updates a session title', async () => {
    const [inserted] = await handle.db.insert(sessions).values({ title: 'Old Title' }).returning()

    await handle.db
      .update(sessions)
      .set({ title: 'New Title' })
      .where(eq(sessions.id, inserted?.id ?? ''))

    const [retrieved] = await handle.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, inserted?.id ?? ''))

    expect(retrieved?.title).toBe('New Title')
  })

  it('deletes a session', async () => {
    const [inserted] = await handle.db.insert(sessions).values({ title: 'To Delete' }).returning()

    await handle.db.delete(sessions).where(eq(sessions.id, inserted?.id ?? ''))

    const result = await handle.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, inserted?.id ?? ''))

    expect(result).toHaveLength(0)
  })
})

describe('DB integration: session entries', () => {
  let handle: DB

  beforeEach(async () => {
    handle = await setupDB()
  })

  afterEach(async () => {
    await handle.close()
  })

  it('inserts and queries entries by session', async () => {
    const [session] = await handle.db.insert(sessions).values({ title: 'S1' }).returning()

    const sessionId = session?.id ?? ''

    await handle.db.insert(sessionEntries).values([
      {
        sessionId,
        tag: 'message',
        role: 'user',
        content: { text: 'Hello' },
        tokenCount: 3,
      },
      {
        sessionId,
        tag: 'message',
        role: 'assistant',
        content: { text: 'Hi there' },
        tokenCount: 5,
      },
      {
        sessionId,
        tag: 'tool_call',
        content: { tool: 'read', input: { path: 'a.ts' } },
        toolName: 'read',
      },
    ])

    const entries = await handle.db
      .select()
      .from(sessionEntries)
      .where(eq(sessionEntries.sessionId, sessionId))

    expect(entries).toHaveLength(3)

    const tags = entries.map((e) => e.tag)
    expect(tags).toContain('message')
    expect(tags).toContain('tool_call')

    const roles = entries.filter((e) => e.role !== null).map((e) => e.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
  })

  it('cascades delete when session is removed', async () => {
    const [session] = await handle.db.insert(sessions).values({ title: 'S1' }).returning()

    const sessionId = session?.id ?? ''

    await handle.db.insert(sessionEntries).values({
      sessionId,
      tag: 'message',
      role: 'user',
      content: { text: 'Hello' },
    })

    // Delete the session — entries should cascade
    await handle.db.delete(sessions).where(eq(sessions.id, sessionId))

    const remaining = await handle.db
      .select()
      .from(sessionEntries)
      .where(eq(sessionEntries.sessionId, sessionId))

    expect(remaining).toHaveLength(0)
  })
})

describe('DB integration: file snapshots', () => {
  let handle: DB

  beforeEach(async () => {
    handle = await setupDB()
  })

  afterEach(async () => {
    await handle.close()
  })

  it('inserts and queries file snapshots', async () => {
    const [session] = await handle.db.insert(sessions).values({ title: 'S1' }).returning()

    const sessionId = session?.id ?? ''

    await handle.db.insert(fileSnapshots).values({
      sessionId,
      filePath: 'src/main.ts',
      content: 'export {}',
      contentHash: 'abc123',
      tokenCount: 2,
      version: 1,
    })

    const [snapshot] = await handle.db
      .select()
      .from(fileSnapshots)
      .where(eq(fileSnapshots.sessionId, sessionId))

    expect(snapshot?.filePath).toBe('src/main.ts')
    expect(snapshot?.contentHash).toBe('abc123')
    expect(snapshot?.version).toBe(1)
  })

  it('supports multiple versions of the same file', async () => {
    const [session] = await handle.db.insert(sessions).values({ title: 'S1' }).returning()

    const sessionId = session?.id ?? ''

    await handle.db.insert(fileSnapshots).values([
      {
        sessionId,
        filePath: 'src/app.ts',
        content: 'v1',
        contentHash: 'hash1',
        version: 1,
      },
      {
        sessionId,
        filePath: 'src/app.ts',
        content: 'v2',
        contentHash: 'hash2',
        version: 2,
      },
    ])

    const versions = await handle.db
      .select()
      .from(fileSnapshots)
      .where(eq(fileSnapshots.sessionId, sessionId))
      .orderBy(desc(fileSnapshots.version))

    expect(versions).toHaveLength(2)
    expect(versions[0]?.version).toBe(2)
    expect(versions[1]?.version).toBe(1)
  })
})

describe('DB integration: compaction archives', () => {
  let handle: DB

  beforeEach(async () => {
    handle = await setupDB()
  })

  afterEach(async () => {
    await handle.close()
  })

  it('inserts and queries compaction archives', async () => {
    const [session] = await handle.db.insert(sessions).values({ title: 'S1' }).returning()

    const sessionId = session?.id ?? ''

    await handle.db.insert(compactionArchives).values({
      sessionId,
      compactionId: '00000000-0000-4000-8000-000000000010',
      archiveType: 'compaction',
      originalEntries: [{ tag: 'message', content: 'old text' }],
      summary: 'Compacted conversation summary',
      tokenCount: 500,
      searchableText: 'old text conversation about files',
    })

    const [archive] = await handle.db
      .select()
      .from(compactionArchives)
      .where(eq(compactionArchives.sessionId, sessionId))

    expect(archive?.archiveType).toBe('compaction')
    expect(archive?.summary).toBe('Compacted conversation summary')
    expect(archive?.originalEntries).toHaveLength(1)
  })
})

describe('DB integration: projects', () => {
  let handle: DB

  beforeEach(async () => {
    handle = await setupDB()
  })

  afterEach(async () => {
    await handle.close()
  })

  it('inserts and queries a project', async () => {
    const [inserted] = await handle.db
      .insert(projects)
      .values({
        id: 'abc123def456abcd',
        worktree: '/home/user/myrepo',
        vcs: 'git',
        name: 'myrepo',
        gitRemote: 'git@github.com:u/myrepo.git',
      })
      .returning()

    expect(inserted).toBeDefined()
    expect(inserted?.id).toBe('abc123def456abcd')
    expect(inserted?.vcs).toBe('git')
    expect(inserted?.createdAt).toBeInstanceOf(Date)
  })

  it('session can reference project via projectId', async () => {
    await handle.db
      .insert(projects)
      .values({ id: 'proj1', worktree: '/repo', vcs: 'git' })
      .returning()

    const [session] = await handle.db
      .insert(sessions)
      .values({ title: 'S', projectId: 'proj1' })
      .returning()

    expect(session?.projectId).toBe('proj1')
  })

  it('session projectId defaults to null', async () => {
    const [session] = await handle.db.insert(sessions).values({ title: 'S' }).returning()
    expect(session?.projectId).toBeNull()
  })

  it('deleting a project sets session.projectId to null', async () => {
    await handle.db.insert(projects).values({ id: 'proj1', worktree: '/repo', vcs: 'git' })
    await handle.db.insert(sessions).values({ title: 'S', projectId: 'proj1' })

    await handle.db.delete(projects).where(eq(projects.id, 'proj1'))

    const [session] = await handle.db.select().from(sessions).where(eq(sessions.title, 'S'))
    expect(session?.projectId).toBeNull()
  })

  it('fromDirectory upserts and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'projdb-'))
    try {
      const p1 = await fromDirectory(handle, dir)
      const p2 = await fromDirectory(handle, dir)
      expect(p1.id).toBe(p2.id)
      expect(p1.worktree).toBe(dir)
      expect(p1.vcs).toBeNull()
      const all = await listProjects(handle)
      expect(all).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('getProject returns null for missing', async () => {
    expect(await getProject(handle, 'nonexistent')).toBeNull()
  })

  it('updateProjectName updates name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'projdb2-'))
    try {
      const created = await fromDirectory(handle, dir)
      const updated = await updateProjectName(handle, created.id, 'My Project')
      expect(updated?.name).toBe('My Project')
      const refetched = await getProject(handle, created.id)
      expect(refetched?.name).toBe('My Project')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('updateProjectName on missing returns null', async () => {
    const result = await updateProjectName(handle, 'nope', 'X')
    expect(result).toBeNull()
  })
})
