import type { Project } from '../types/index.js'
import { apiRequest } from './api.js'

/** Projects API 客户端。 */
const projectAPI = {
  /** 列出所有已注册项目。 */
  list: () => apiRequest<Project[]>('/api/projects'),
  /** 解析当前服务端工作区对应的项目。 */
  current: () => apiRequest<Project>('/api/projects/current'),
  /** 按 id 获取项目。 */
  get: (id: string) => apiRequest<Project>(`/api/projects/${id}`),
  /** 解析目录并创建/更新项目记录。 */
  fromDirectory: (directory: string) =>
    apiRequest<Project>('/api/projects/from-directory', {
      method: 'POST',
      body: JSON.stringify({ directory }),
    }),
  /** 更新项目名。 */
  updateName: (id: string, name: string) =>
    apiRequest<Project>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
}

export { projectAPI }
