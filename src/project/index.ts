import { loadConfigScopes } from '../core/config.js'
import type { DB } from '../db/client.js'
import {
  enforceProjectTrust,
  fromDirectory,
  getByDirectory,
  getProject,
  listProjects,
  relocateProject,
  trustProject,
  updateProjectName,
} from './project.js'
import { projectTrustCurrent } from './trust.js'

/** cwd 是否当前可信项目（已注册 + trustedAt 非空 + 风险指纹未漂移）。
 *  与聊天门禁/插件加载同口径；未注册、查询失败或指纹漂移 → 未信任
 *  （fail-closed）。CLI/serve 的插件加载、工作流注册表构建据此决定
 *  是否 import 项目级文件（plugins/workflows 均为仓库自带执行面）。 */
async function resolveCwdProjectTrusted(db: DB, cwd: string): Promise<boolean> {
  try {
    const p = await getByDirectory(db, cwd)
    if (p?.trustedAt != null) {
      return projectTrustCurrent(loadConfigScopes(cwd).project, p.trustedAt, p.riskFingerprint, cwd)
    }
  } catch {
    // 信任状态查询失败 → 保持未信任（宁可少加载）
  }
  return false
}

export type { Project } from './project.js'
export type { ResolvedProject } from './resolve.js'
export { resolveProject } from './resolve.js'
export {
  enforceProjectTrust,
  fromDirectory,
  getByDirectory,
  getProject,
  listProjects,
  relocateProject,
  resolveCwdProjectTrusted,
  trustProject,
  updateProjectName,
}
