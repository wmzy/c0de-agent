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

/** 用户自建内容（/config 写项目作用域、工作流创建/删除）落地后的信任指纹刷新：
 *  已信任项目重算并落盘风险指纹，把用户刚写入的内容纳入信任快照——不变量
 *  「用户自写内容延长信任而非触发复检」（否则「信任→自建→指纹漂移」把自己
 *  锁出门禁）。未信任/未注册项目不动（信任批准只能来自显式 trust 动作）。
 *  返回按刷新后快照判定的「当前可信」（fail-closed：未信任/未注册 → false），
 *  供调用方决定热重载是否带项目级发现。指纹刷新失败向上抛，由调用方决定
 *  是否阻塞（各入口均不阻塞，最坏回到复检路径）。 */
async function refreshTrustedProjectFingerprint(db: DB, dir: string): Promise<boolean> {
  const p = await getByDirectory(db, dir)
  if (p?.trustedAt == null) return false
  // trustProject 返回刷新后的行；并发删除等导致返回 null 时回退旧快照判定。
  const refreshed = (await trustProject(db, p.id)) ?? p
  return projectTrustCurrent(
    loadConfigScopes(dir).project,
    refreshed.trustedAt,
    refreshed.riskFingerprint,
    dir,
  )
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
  refreshTrustedProjectFingerprint,
  relocateProject,
  resolveCwdProjectTrusted,
  trustProject,
  updateProjectName,
}
