import type { ToolListItem } from '../types/index.js'
import { apiRequest } from './api.js'

const toolAPI = {
  /** 列出可用工具（不含 execute 函数）。?projectId= 按项目合并配置过滤。 */
  list: (projectId?: string) =>
    apiRequest<ToolListItem[]>(
      `/api/tools${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
}

export { toolAPI }
