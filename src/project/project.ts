import { eq } from 'drizzle-orm'
import { basename } from 'node:path'
import type { DB } from '../db/client.js'
import { projects } from '../db/schema.js'
import { resolveProject } from './resolve.js'

export type Project = {
  id: string
  worktree: string
  vcs: 'git' | null
  name: string | null
  gitRemote: string | null
  createdAt: number
  updatedAt: number
}

function rowToProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    worktree: row.worktree,
    vcs: (row.vcs as 'git' | null) ?? null,
    name: row.name,
    gitRemote: row.gitRemote,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.getTime()
        : new Date(row.createdAt).getTime(),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.getTime()
        : new Date(row.updatedAt).getTime(),
  }
}

/** 解析目录 + upsert 项目记录。返回 Project。 */
export async function fromDirectory(handle: DB, directory: string): Promise<Project> {
  const resolved = resolveProject(directory)
  const name = basename(resolved.worktree) || resolved.worktree
  await handle.db
    .insert(projects)
    .values({
      id: resolved.id,
      worktree: resolved.worktree,
      vcs: resolved.vcs,
      name,
      gitRemote: resolved.gitRemote,
    })
    .onConflictDoUpdate({
      target: projects.id,
      set: {
        worktree: resolved.worktree,
        vcs: resolved.vcs,
        gitRemote: resolved.gitRemote,
        updatedAt: new Date(),
      },
    })
  const result = await getProject(handle, resolved.id)
  if (!result) throw new Error(`Project upsert failed for ${directory}`)
  return result
}

export async function listProjects(handle: DB): Promise<Project[]> {
  const rows = await handle.db.select().from(projects)
  return rows.map(rowToProject)
}

export async function getProject(
  handle: DB,
  id: string,
): Promise<Project | null> {
  const [row] = await handle.db.select().from(projects).where(eq(projects.id, id))
  return row ? rowToProject(row) : null
}

export async function getByDirectory(
  handle: DB,
  directory: string,
): Promise<Project | null> {
  const resolved = resolveProject(directory)
  return getProject(handle, resolved.id)
}

export async function updateProjectName(
  handle: DB,
  id: string,
  name: string,
): Promise<Project | null> {
  const [row] = await handle.db
    .update(projects)
    .set({ name, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning()
  return row ? rowToProject(row) : null
}