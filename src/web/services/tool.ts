import { get } from '@/services/api.js'

import type { ToolListItem } from '@/types/index.js'

const toolAPI = {
  /** 列出可用工具（不含 execute 函数）。?projectId= 按项目合并配置过滤。 */
  list: (projectId?: string) =>
    get<ToolListItem[]>(
      `/api/tools${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
}

export { toolAPI }
