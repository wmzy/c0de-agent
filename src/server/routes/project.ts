import { Hono } from 'hono'
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

type ProjectWithBranch = Project & { gitBranch: string | null }

/** 实时取 git 分支（分支随时变，不存 DB）。 */
function withBranch(project: Project): ProjectWithBranch {
  return { ...project, gitBranch: resolveProject(project.worktree).gitBranch }
}

function createProjectRoute(ctx: ServerContext): Hono {
  const app = new Hono()

  // 解析目录并创建/更新项目记录
  app.post('/from-directory', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const directory = body.directory as string | undefined
    if (!directory) return apiError(c, 400, 'BAD_REQUEST', 'directory is required')
    const project = await fromDirectory(ctx.db, directory)
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

  return app
}

export { createProjectRoute }
