// src/server/routes/project.ts
import { existsSync } from 'node:fs'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { kanbanBoards, projects, sessions } from '../../db/schema.js'
import {
  fromDirectory,
  getProject,
  listProjects,
  resolveProject,
  updateProjectName,
} from '../../project/index.js'
import type { Project } from '../../project/project.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'
import { expandPath } from './filesystem.js'

type ProjectWithBranch = Project & { gitBranch: string | null; worktreeMissing: boolean }

/** 实时取 git 分支（分支随时变，不存 DB）。worktree 不存在时标记缺失。 */
function withBranch(project: Project): ProjectWithBranch {
  const worktreeMissing = !existsSync(project.worktree)
  return { ...project, gitBranch: resolveProject(project.worktree).gitBranch, worktreeMissing }
}

function createProjectRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 解析目录并创建/更新项目记录
  app.post('/from-directory', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const directory = body.directory as string | undefined
    if (!directory) return apiError(c, 400, 'BAD_REQUEST', 'directory is required')
    // 展开 ~ 前缀为 home 绝对路径（前端可能传 ~/... 形式）
    const project = await fromDirectory(ctx.db, expandPath(directory))
    return c.json(withBranch(project), 200)
  })

  // 列出所有项目
  app.get('/', async (c) => {
    const list = await listProjects(ctx.db)
    return c.json(list.map(withBranch))
  })

  // 解析服务端 cwd 对应的项目（未注册则自动创建）
  app.get('/current', async (c) => {
    const project = await fromDirectory(ctx.db, ctx.cwd)
    return c.json(withBranch(project), 200)
  })

  // 按 id 获取项目
  app.get('/:id', async (c) => {
    const project = await getProject(ctx.db, c.req.param('id'))
    if (!project) return apiError(c, 404, 'NOT_FOUND', 'Project not found')
    return c.json(withBranch(project))
  })

  // 更新项目名
  app.patch('/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const name = body.name as string | undefined
    if (!name) return apiError(c, 400, 'BAD_REQUEST', 'name is required')
    const project = await updateProjectName(ctx.db, c.req.param('id'), name)
    if (!project) return apiError(c, 404, 'NOT_FOUND', 'Project not found')
    return c.json(withBranch(project))
  })

  // P1-9 + P2-2：删除项目记录（看板级联删除）。
  // 会话不再留孤儿（FK set null 后在任何项目视图都不可见且 cwd 回退 serve 目录）：
  // 删除前把该项目全部未删除会话软删除进回收站（30 天内可恢复），
  // 并把 worktreePath 落盘——恢复后 resolveAgentCwd 仍能解析原工作目录。
  // 有活跃 run 绑定该项目时拒绝删除，避免 agent 工作目录悬空。
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const project = await getProject(ctx.db, id)
    if (!project) return apiError(c, 404, 'NOT_FOUND', 'Project not found')

    // 活跃 run 守卫：任一活跃会话归属于该项目 → 拒绝
    const activeSessionIds = new Set<string>()
    for (const run of ctx.agentManager.children(id)) {
      activeSessionIds.add(run.sessionId)
    }
    if (activeSessionIds.size === 0) {
      // 检查该项目下是否有正在进行（含占位）的会话
      const rows = await ctx.db.db
        .select({ id: sessions.id, projectId: sessions.projectId })
        .from(sessions)
        .where(and(eq(sessions.projectId, id)))
      const active = rows.filter((r) => ctx.agentManager.get(r.id))
      if (active.length > 0) {
        return apiError(
          c,
          409,
          'PROJECT_HAS_ACTIVE_SESSIONS',
          `项目下有 ${active.length} 个进行中的对话，请先中止后再删除`,
        )
      }
    }

    let deletedSessions = 0
    await ctx.db.db.transaction(async (tx) => {
      // 该项目下所有未删除会话：记录 worktreePath（若尚无）并软删除进回收站
      const now = new Date()
      const bound = await tx
        .select({ id: sessions.id, worktreePath: sessions.worktreePath })
        .from(sessions)
        .where(and(eq(sessions.projectId, id), isNull(sessions.deletedAt)))
      for (const s of bound) {
        if (!s.worktreePath) {
          await tx
            .update(sessions)
            .set({ worktreePath: project.worktree })
            .where(eq(sessions.id, s.id))
        }
        await tx.update(sessions).set({ deletedAt: now }).where(eq(sessions.id, s.id))
        deletedSessions += 1
      }
      await tx.delete(kanbanBoards).where(eq(kanbanBoards.projectId, id))
      await tx.delete(projects).where(eq(projects.id, id))
    })
    return c.json({ ok: true, deletedSessions })
  })

  return app
}

export { createProjectRoute }
