import { basename } from 'node:path'
import { eq } from 'drizzle-orm'
import { loadConfigScopes } from '../core/config.js'
import type { DB } from '../db/client.js'
import { kanbanBoards, projects, sessions } from '../db/schema.js'
import type { Config } from '../shared/types/config.js'
import { resolveProject } from './resolve.js'
import { computeProjectRiskFingerprint, projectTrustNeeded } from './trust.js'

export type Project = {
  id: string
  worktree: string
  vcs: 'git' | null
  name: string | null
  gitRemote: string | null
  createdAt: number
  updatedAt: number
  /** 用户显式信任该项目作用域配置/插件的时间戳；null=未信任（P0-2 信任边界）。 */
  trustedAt: number | null
  /** 信任时的风险配置指纹；null=历史记录（无指纹，见 schema 注释）。 */
  riskFingerprint: string | null
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
    trustedAt:
      row.trustedAt instanceof Date
        ? row.trustedAt.getTime()
        : row.trustedAt
          ? new Date(row.trustedAt).getTime()
          : null,
    riskFingerprint: row.riskFingerprint,
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
 * P0-2：显式信任项目——用户在信任确认弹窗中批准项目作用域配置/插件后落盘。
 * 信任是「克隆即信任」防线的落点；未信任项目携带风险配置时聊天入口被门禁拦截。
 * 一次性动作：信任后不再拦截（用户可随时在设置中收回项目级配置）。
 * P1：信任时同时落盘「风险配置指纹」（当前项目作用域的 summarizeProjectRisk
 * 快照）——此后若仓库 git pull 新增 auto 权限/插件/MCP 等风险键，指纹漂移会
 * 重新触发门禁复检，而非永久信任。
 */
export async function trustProject(handle: DB, id: string): Promise<Project | null> {
  const existing = await getProject(handle, id)
  if (!existing) return null
  const scope = loadConfigScopes(existing.worktree).project
  // 指纹含 MCP 参数与插件文件内容（trust.ts computeProjectRiskFingerprint）——
  // 信任批准的是「当时的完整风险面」，此后任何漂移（含插件代码变更）都会复检。
  const riskFingerprint = computeProjectRiskFingerprint(scope, { projectDir: existing.worktree })
  const rows = await handle.db
    .update(projects)
    .set({ trustedAt: new Date(), riskFingerprint })
    .where(eq(projects.id, id))
    .returning()
  const row = rows[0]
  return row ? rowToProject(row) : null
}

/**
 * P0 CLI 项目信任门禁：agent 执行路径（c0de chat / c0de acp）在无 Web 确认弹窗的
 * 情况下，若目录项目未信任（或信任后未 config 漂移）且项目作用域/全局权限配置含
 * 风险项，直接抛错引导 `c0de trust <dir>`——与 Web 聊天入口 409 TRUST_REQUIRED 用
 * 同一套 projectTrustNeeded 判定，杜绝「Web 拦、CLI 裸奔」的不对称。
 * 无风险项时不拦；trust/sessions 等非 agent 命令由调用方跳过此门禁。
 * `globalRaw` 参数仅供测试注入确定性全局配置（生产走本机 ~/.c0de/config.json）。
 */
export async function enforceProjectTrust(
  handle: DB,
  cwd: string,
  globalRaw?: Partial<Config> | undefined,
): Promise<void> {
  const scopes = loadConfigScopes(cwd)
  const effectiveGlobal = globalRaw === undefined ? scopes.global : globalRaw
  let trustedAt: number | null = null
  let riskFingerprint: string | null = null
  try {
    const project = await getByDirectory(handle, cwd)
    trustedAt = project?.trustedAt ?? null
    riskFingerprint = project?.riskFingerprint ?? null
  } catch {
    // 信任状态查询失败 → 按未信任处理（宁可拦截，不静默放行）
  }
  const risks = projectTrustNeeded(scopes.project, effectiveGlobal, trustedAt, riskFingerprint, cwd)
  if (risks.length === 0) return
  const globalKinds = new Set(['permission-auto', 'permission-timeout-deny'])
  const globalOnly = risks.every((r) => globalKinds.has(r.kind))
  const sourceNote = globalOnly
    ? '（风险来自全局配置 permission；如有意为之可执行 c0de trust 一次性放行本项目）'
    : ''
  throw new Error(
    `项目目录 ${cwd} 的配置含需要你确认的风险项。\n` +
      `  请先审查后执行 c0de trust <目录> --yes 显式信任；或改用 c0de serve 在浏览器确认。\n` +
      `  风险项：${risks.map((r) => r.kind).join('、')}${sourceNote}`,
  )
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
