import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DB } from '../../db/client.js'
import { createDB } from '../../db/client.js'
import { migrateDB } from '../../db/migrate.js'
import { createRegistry } from '../../llm/registry.js'
import { createServerContext } from '../context.js'
import type { Project } from '../../project/project.js'
import { createProjectRoute } from './project.js'

let dbHandle: DB | undefined
afterEach(async () => {
  await dbHandle?.close()
  dbHandle = undefined
})

async function setup(cwd?: string) {
  const db = await createDB({ driver: 'pglite' })
  dbHandle = db
  await migrateDB(db)
  const ctx = createServerContext({ db, llmRegistry: createRegistry(), cwd })
  const app = createProjectRoute(ctx)
  return { app, ctx, db }
}

describe('project route', () => {
  it('POST /from-directory creates project', async () => {
    const { app } = await setup()
    const dir = mkdtempSync(join(tmpdir(), 'projr-'))
    try {
      const res = await app.request('/from-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: dir }),
      })
      expect(res.status).toBe(200)
      const project = (await res.json()) as Project & { gitBranch: string | null }
      expect(project.id).toHaveLength(16)
      expect(project.worktree).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('GET / lists projects', async () => {
    const { app } = await setup()
    const dir = mkdtempSync(join(tmpdir(), 'projr2-'))
    try {
      await app.request('/from-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: dir }),
      })
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const list = (await res.json()) as Project[]
      expect(list).toHaveLength(1)
      expect(list[0]?.worktree).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('GET /current resolves ctx.cwd project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'projr3-'))
    try {
      const { app } = await setup(dir)
      const res = await app.request('/current')
      expect(res.status).toBe(200)
      const project = (await res.json()) as Project
      expect(project.worktree).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('GET /:id returns project', async () => {
    const { app } = await setup()
    const dir = mkdtempSync(join(tmpdir(), 'projr4-'))
    try {
      const created = await app.request('/from-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: dir }),
      })
      const project = (await created.json()) as Project
      const res = await app.request(`/${project.id}`)
      expect(res.status).toBe(200)
      const fetched = (await res.json()) as Project
      expect(fetched.id).toBe(project.id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('GET /:id 404 for missing', async () => {
    const { app } = await setup()
    const res = await app.request('/nonexistent')
    expect(res.status).toBe(404)
  })

  it('PATCH /:id updates name', async () => {
    const { app } = await setup()
    const dir = mkdtempSync(join(tmpdir(), 'projr5-'))
    try {
      const created = await app.request('/from-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: dir }),
      })
      const project = (await created.json()) as Project
      const res = await app.request(`/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Custom Name' }),
      })
      expect(res.status).toBe(200)
      const updated = (await res.json()) as Project
      expect(updated.name).toBe('Custom Name')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
