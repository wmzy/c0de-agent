import { get, withProjectId } from '@/services/api.js'

import type { ToolListItem } from '@/types/index.js'

const toolAPI = {
  /** 列出可用工具（不含 execute 函数）。?projectId= 按项目合并配置过滤。 */
  list: (projectId?: string) => get<ToolListItem[]>(withProjectId('/api/tools', projectId)),
}

export { toolAPI }

/** 可用工具列表查询键（ToolToggle 正本）。projectId 缺省时是服务端启动
 *  配置的合并结果，用 'server' 占位段区分，避免 undefined 与显式项目共享缓存。 */
export function toolsKey(projectId?: string) {
  return ['tools', projectId ?? 'server'] as const
}
