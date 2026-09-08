import { basename } from 'node:path'
import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { kanbanBoards, projects, sessions } from '../db/schema.js'
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
      row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(row.createdAt).getTime(),
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.getTime() : new Date(row.updatedAt).getTime(),
  }
}

/**
 * 解析目录 + upsert 项目记录。返回 Project。
 *
 * 历史缺陷修复：旧版 resolveProject 曾用 git remote 作 id，remote 变更（先无后加）
 * 会导致同一目录分裂成多个项目记录，挂在旧 id 的会话随之「消失」。这里在 upsert 后
 * 合并同 worktree 的重复项目：把孤儿 id 名下的会话迁回规范 id，再删除孤儿记录。
 * 幂等——无重复时为 no-op。
 */
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

  await mergeDuplicateProjects(handle, resolved.id, resolved.worktree)

  const result = await getProject(handle, resolved.id)
  if (!result) throw new Error(`Project upsert failed for ${directory}`)
  return result
}

/**
 * 合并同 worktree 下 id ≠ canonicalId 的项目记录：迁移其会话到 canonicalId 后删除。
 * 清理因 id 漂移（remote 变更）产生的历史重复项目，使列表不再出现同名重复项，
 * 也让挂在漂移 id 上的会话重新归属规范项目。
 */
async function mergeDuplicateProjects(
  handle: DB,
  canonicalId: string,
  worktree: string,
): Promise<void> {
  const dups = await handle.db.select().from(projects).where(eq(projects.worktree, worktree))
  for (const dup of dups) {
    if (dup.id === canonicalId) continue
    await handle.db
      .update(sessions)
      .set({ projectId: canonicalId })
      .where(eq(sessions.projectId, dup.id))
    await handle.db.delete(projects).where(eq(projects.id, dup.id))
  }
}

export async function listProjects(handle: DB): Promise<Project[]> {
  const rows = await handle.db.select().from(projects)
  return rows.map(rowToProject)
}

export async function getProject(handle: DB, id: string): Promise<Project | null> {
  const [row] = await handle.db.select().from(projects).where(eq(projects.id, id))
  return row ? rowToProject(row) : null
}

export async function getByDirectory(handle: DB, directory: string): Promise<Project | null> {
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

/**
 * 项目重新定位（A1：目录被移动/重命名后的恢复通道）。
 *
 * 项目身份 = sha256(worktree)，目录移动后旧项目记录的 worktree 失效且不可改 id。
 * 此前唯一恢复路径是「删除项目」：会话打散进孤儿回收站逐条恢复，看板永久丢失。
 * 本函数在单事务内把项目整体迁移到新目录身份（新 id），保住看板与会话归属：
 *   1. 以新目录解析出的 id upsert 项目行（沿用旧名称）；
 *   2. 会话 projectId/worktreePath 迁移到新身份；
 *   3. 看板 projectId 迁移（目标为新身份，唯一约束无冲突）；
 *   4. 删除旧项目行。
 * 同一 id（如 git 仓库根未变、仅路径符号变化）→ 仅更新 worktree，不换身份。
 * 目标目录已注册为另一项目时抛 TARGET_OCCUPIED（调用方转 409），绝不静默合并。
 */
export async function relocateProject(handle: DB, id: string, directory: string): Promise<Project> {
  const current = await getProject(handle, id)
  if (!current) throw new Error('PROJECT_NOT_FOUND')
  const resolved = resolveProject(directory)

  if (resolved.id === id) {
    // 身份不变：仅刷新 worktree 与 git 元数据；会话 worktreePath 同步。
    await handle.db.transaction(async (tx) => {
      await tx
        .update(projects)
        .set({
          worktree: resolved.worktree,
          vcs: resolved.vcs,
          gitRemote: resolved.gitRemote,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, id))
      await tx
        .update(sessions)
        .set({ worktreePath: resolved.worktree })
        .where(eq(sessions.projectId, id))
    })
  } else {
    const occupied = await getProject(handle, resolved.id)
    if (occupied) {
      throw new Error(`TARGET_OCCUPIED: 目标目录已注册为项目「${occupied.name ?? '未命名项目'}」`)
    }
    await handle.db.transaction(async (tx) => {
      await tx
        .insert(projects)
        .values({
          id: resolved.id,
          worktree: resolved.worktree,
          vcs: resolved.vcs,
          name: current.name ?? basename(resolved.worktree),
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
      await tx
        .update(sessions)
        .set({ projectId: resolved.id, worktreePath: resolved.worktree })
        .where(eq(sessions.projectId, id))
      await tx
        .update(kanbanBoards)
        .set({ projectId: resolved.id })
        .where(eq(kanbanBoards.projectId, id))
      await tx.delete(projects).where(eq(projects.id, id))
    })
  }

  const result = await getProject(handle, resolved.id)
  if (!result) throw new Error(`Relocate failed for ${directory}`)
  return result
}
