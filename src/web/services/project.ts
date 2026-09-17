import { del, get, patch, post } from '@/services/api.js'

import type { Project } from '@/types/index.js'

/** Projects API 客户端。 */
const projectAPI = {
  /** 列出所有已注册项目。 */
  list: () => get<Project[]>('/api/projects'),
  /** 解析当前服务端工作区对应的项目。 */
  current: () => get<Project>('/api/projects/current'),
  /** 按 id 获取项目。 */
  get: (id: string) => get<Project>(`/api/projects/${id}`),
  /** 解析目录并创建/更新项目记录。 */
  fromDirectory: (directory: string) =>
    post<Project>('/api/projects/from-directory', { directory }),
  /** 更新项目名。 */
  updateName: (id: string, name: string) => patch<Project>(`/api/projects/${id}`, { name }),
  /** A1：项目重新定位——目录被移动/重命名后，整体迁移会话与看板到新目录身份。 */
  relocate: (id: string, directory: string) =>
    post<{ ok: boolean; project: Project }>(`/api/projects/${id}/relocate`, { directory }),
  /** P0-2：显式信任项目（用户批准项目作用域配置/插件后调用，一次性）。 */
  trust: (id: string) => post<{ ok: boolean; project: Project }>(`/api/projects/${id}/trust`),
  /** 删除项目记录（看板进入回收站可恢复；会话保留）。 */
  remove: (id: string) => del<{ ok: boolean }>(`/api/projects/${id}`),
}

export { projectAPI }
