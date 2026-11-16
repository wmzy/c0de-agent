import type { Context } from 'hono'
import type { DB } from '../../db/client.js'
import { getProject, type Project } from '../../project/project.js'
import { apiError } from '../middleware/error.js'

/** getProjectOr404 的判别结果：ok=false 时 response 为可直接 return 的 404。 */
export type ProjectOr404 = { ok: true; project: Project } | { ok: false; response: Response }

/**
 * 路由层「项目存在守卫」的单点实现：查不到项目 → 404 PROJECT_NOT_FOUND。
 * message 可按场景覆盖（如「目标项目不存在」「恢复目标项目不存在」），缺省
 * 「项目不存在」。此前 15+ 处内联 getProject + apiError 骨架，错误码/文案已
 * 漂移出三种变体（NOT_FOUND 英文 / PROJECT_NOT_FOUND 带场景中文文案）。
 */
export async function getProjectOr404(
  handle: DB,
  c: Context,
  projectId: string,
  message?: string,
): Promise<ProjectOr404> {
  const project = await getProject(handle, projectId)
  if (!project) {
    return { ok: false, response: apiError(c, 404, 'PROJECT_NOT_FOUND', message ?? '项目不存在') }
  }
  return { ok: true, project }
}
